use std::{
    env,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use rand::Rng;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::task::{self, JoinHandle};

#[derive(Serialize, Deserialize, Debug)]
struct Message {
    id: String,
    timestamp: String,
}

#[derive(Serialize, Deserialize)]
struct CreateMessageBody {
    stream: String,
    id: String,
    message: Message,
}

fn now() -> u64 {
    let start = SystemTime::now();
    let since_the_epoch = start
        .duration_since(UNIX_EPOCH)
        .expect("time should go forward");

    since_the_epoch.as_secs() * 1000 + since_the_epoch.subsec_nanos() as u64 / 1_000_000
}

async fn long_poll(
    http_client: &Client,
    base_url: &str,
    doc: String,
    version: String,
    avg_delay: &mut u64,
    num_loops: u64,
) -> Option<String> {
    let endpoint = format!("{base_url}/messages");
    let response = match http_client
        .get(&endpoint)
        .query(&[("stream", doc), ("version", version.clone())])
        .send()
        .await
    {
        Err(_) => {
            return None;
        }
        Ok(r) => r,
    };

    let text = response.text().await.unwrap();
    let messages_result = serde_json::from_str::<Vec<Message>>(&text)
        .with_context(|| format!("Unable to deserialise response. Body was: \"{}\"", text));

    let messages = match messages_result {
        Err(_) => {
            println!("{text:?}");
            return None;
        }
        Ok(json) => json,
    };

    for message in messages.iter() {
        let timestamp_str = &message.timestamp;
        let timestamp = timestamp_str.parse::<u64>().unwrap();
        *avg_delay = (*avg_delay + (now() - timestamp)) / num_loops;
    }

    match messages.last() {
        None => None,
        Some(m) => Some(m.id.clone()),
    }
}

async fn post_message(http_client: &Client, base_url: &str, doc: String, version: String) {
    let in_ms = now();

    let endpoint = format!("{base_url}/message");
    let body = CreateMessageBody {
        stream: doc,
        id: version.clone(),
        message: Message {
            id: version.clone(),
            timestamp: in_ms.to_string(),
        },
    };

    match http_client.post(&endpoint).json(&body).send().await {
        Err(_) => (), // println!("{err:#?}"),
        Ok(_) => (),
    }
}

#[tokio::main]
async fn main() {
    let http_client = Arc::new(Client::new());
    let base_url = env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());

    let num_docs = match env::var("NUM_DOCS") {
        Err(_) => 10,
        Ok(listeners) => match listeners.parse::<u64>() {
            Err(_) => 10,
            Ok(parsed) => parsed,
        },
    };

    let num_listeners = match env::var("NUM_LISTENERS") {
        Err(_) => 100,
        Ok(listeners) => match listeners.parse::<u64>() {
            Err(_) => 100,
            Ok(parsed) => parsed,
        },
    };

    let num_posters = match env::var("NUM_POSTERS") {
        Err(_) => 100,
        Ok(posters) => match posters.parse::<u64>() {
            Err(_) => 100,
            Ok(parsed) => parsed,
        },
    };

    for i in 0..num_listeners {
        let http_client = http_client.clone();
        let doc_id = rand::rng().random_range(0..num_docs);
        let base_url = base_url.clone();
        task::spawn(async move {
            let mut version = "0".to_string();
            let mut avg_delay: u64 = 0;
            let mut num_loops: u64 = 1;
            loop {
                match long_poll(
                    &http_client,
                    &base_url,
                    format!("doc-{doc_id}"),
                    version.clone(),
                    &mut avg_delay,
                    num_loops,
                )
                .await
                {
                    None => (),
                    Some(v) => {
                        if num_loops % 10 == 0 {
                            println!(
                                "Average delay for listener {i} after {num_loops} polls: {avg_delay}"
                            )
                        }
                        version = v
                    }
                };
                num_loops += 1;
            }
        });
    }

    let mut handle: Option<JoinHandle<()>> = None;
    for _ in 0..num_posters {
        let http_client = http_client.clone();
        let doc_id = rand::rng().random_range(0..num_docs);
        let base_url = base_url.clone();
        handle = Some(task::spawn(async move {
            let mut version = 0;
            loop {
                post_message(
                    &http_client,
                    &base_url,
                    format!("doc-{doc_id}"),
                    version.to_string(),
                )
                .await;
                version += 1;
            }
        }));
    }

    let _ = handle.unwrap().await;
}
