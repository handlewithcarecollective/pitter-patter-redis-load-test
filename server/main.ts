import express from "express";
import { createClient } from "redis";

const app = express();
app.use(express.json());

const port = 3000;

const unblockClient = createClient({
  url: process.env["REDIS_URL"],
});
await unblockClient.connect();

const readClient = createClient({
  url: process.env["REDIS_URL"],
});
await readClient.connect();
const readClientId = await readClient.clientId();

const writeClient = createClient({
  url: process.env["REDIS_URL"],
});
await writeClient.connect();

const streamMap = new Map<string, Map<string, ((messages: any) => void)[]>>();
const streamCancellations = new Map<string, NodeJS.Timeout>();

let xRead: ReturnType<typeof readClient.xRead> | null = null;

function processMessages(
  readMessages: Awaited<ReturnType<typeof readClient.xRead>>,
) {
  if (!readMessages) {
    restartXRead();
    return;
  }
  for (const { name: stream, messages } of readMessages as {
    name: string;
    messages: { id: string; message: any }[];
  }[]) {
    const messageMap = new Map<(messages: any) => void, string[]>();
    const versionMap = streamMap.get(stream);
    if (!versionMap) continue;
    const versionsToDelete = new Set<string>();
    for (const { id, message } of messages) {
      for (const [version, resolvers] of versionMap.entries()) {
        const idVersion = id.split("-")[0]!;
        if (version >= idVersion) {
          continue;
        }

        for (const resolve of resolvers) {
          const foundMessages = messageMap.get(resolve);
          if (foundMessages) {
            foundMessages.push(message);
          } else {
            messageMap.set(resolve, [message]);
          }
        }
        versionsToDelete.add(version);
      }
    }

    for (const version of versionsToDelete) {
      versionMap.delete(version);

      if (versionMap.size === 0) {
        streamMap.delete(stream);
      }
    }
    for (const [resolve, foundMessages] of messageMap.entries()) {
      resolve(foundMessages);
    }
  }
  restartXRead();
}

function restartXRead() {
  if (!streamMap.size) {
    xRead = null;
    return;
  }

  const streams = streamMap
    .entries()
    .map(([stream, versionMap]) => [
      stream,
      versionMap
        .keys()
        .reduce((acc, version) => (acc < version ? acc : version)),
    ])
    .map(([stream, id]) => ({ key: stream, id }))
    .toArray();

  xRead = readClient.xRead(streams, { BLOCK: 30000 });
  xRead.then(processMessages).catch((e) => console.error("XREAD error", e));
}

restartXRead();

app.post("/message", async (req, res) => {
  const { stream, id, message } = req.body;
  try {
    await writeClient.xAdd(stream, id, message);
  } catch {
    res.status(409);
    res.send(null);
    return;
  }
  res.status(204);
  res.send(null);
});

app.get("/messages", async (req, res) => {
  const { stream, version } = req.query as { stream: string; version: string };

  const { promise, resolve } = Promise.withResolvers<any>();
  const existing = streamMap.get(stream);
  if (!existing) {
    streamMap.set(stream, new Map([[version, [resolve]]]));

    if (xRead) {
      await unblockClient.sendCommand([
        "CLIENT",
        "UNBLOCK",
        readClientId.toString(),
      ]);
    }

    restartXRead();
  } else {
    const alreadyListening = existing.keys().some((v) => v <= version);
    const existingResolvers = existing.get(version);

    if (existingResolvers) {
      existingResolvers.push(resolve);
      const cancellation = streamCancellations.get(`${stream}:${version}`);
      if (cancellation) {
        clearTimeout(cancellation);
        streamCancellations.delete(`${stream}:${version}`);
      }
    } else {
      existing.set(version, [resolve]);
    }

    if (!alreadyListening) {
      if (xRead) {
        await unblockClient.sendCommand([
          "CLIENT",
          "UNBLOCK",
          readClientId.toString(),
        ]);
      }

      restartXRead();
    }
  }

  const messages = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, 30000)).then(() => {
      const versionMap = streamMap.get(stream);
      if (!versionMap) return [];
      if ((versionMap.get(version)?.length ?? 0) <= 1) {
        versionMap.delete(version);
        if (versionMap.size === 0) {
          streamMap.delete(stream);
        }
      } else {
        versionMap.set(
          version,
          versionMap.get(version)!.filter((r) => r === resolve),
        );
      }
      return [];
    }),
  ]);

  res.status(200);
  res.send(messages);
});

app.listen(port, process.env["HOSTNAME"] ?? "localhost", () => {
  unblockClient.flushAll();
  console.log(`Listening on port ${port}`);
});
