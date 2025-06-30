import express from "express";
import { GlideClient, GlideClientConfiguration } from "@valkey/valkey-glide";

const app = express();
app.use(express.json());

const port = 3000;

const clientOptions: GlideClientConfiguration = {
  addresses: [
    {
      host: process.env["REDIS_HOST"]!,
      port: parseInt(process.env["REDIS_PORT"]!, 10),
    },
  ],
  ...(process.env["REDIS_PASSWORD"] && {
    credentials: {
      username: process.env["REDIS_USERNAME"],
      password: process.env["REDIS_PASSWORD"],
    },
  }),
  useTLS: process.env["REDIS_TLS"] === "true",
};

const unblockClient = await GlideClient.createClient(clientOptions);

const readClient = await GlideClient.createClient(clientOptions);
const readClientId = await readClient.clientId();

const writeClient = await GlideClient.createClient(clientOptions);

const streamMap = new Map<string, Map<string, ((messages: any) => void)[]>>();

let xread: ReturnType<typeof readClient.xread> | null = null;

function processMessages(
  readMessages: Awaited<ReturnType<typeof readClient.xread>>,
) {
  if (!readMessages) {
    restartXRead();
    return;
  }
  for (const { key: stream, value } of readMessages) {
    const messageMap = new Map<(messages: any) => void, string[]>();
    const versionMap = streamMap.get(stream.toString());
    if (!versionMap) continue;
    for (const [id, messageEntries] of Object.entries(value)) {
      const message = Object.fromEntries(messageEntries);
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
        versionMap.delete(version);
      }
    }
    if (versionMap.size === 0) {
      streamMap.delete(stream.toString());
    }
    for (const [resolve, foundMessages] of messageMap.entries()) {
      resolve(foundMessages);
    }
  }
  restartXRead();
}

function restartXRead() {
  if (!streamMap.size) {
    xread = null;
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
    .reduce((acc, [stream, id]) => ({ ...acc, [stream]: id }), {});

  xread = readClient.xread(streams, { block: 30000 });
  xread.then(processMessages).catch((e) => console.error("XREAD error", e));
}

restartXRead();

app.post("/message", async (req, res) => {
  const { stream, id, message } = req.body;
  try {
    await writeClient.xadd(stream, Object.entries(message), { id });
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

    if (xread) {
      await unblockClient.customCommand([
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
    } else {
      existing.set(version, [resolve]);
    }

    if (!alreadyListening) {
      if (xread) {
        await unblockClient.customCommand([
          "CLIENT",
          "UNBLOCK",
          readClientId.toString(),
        ]);
      }

      restartXRead();
    }
  }

  const messages = await promise;

  res.status(200);
  res.send(messages);
});

app.listen(port, process.env["HOSTNAME"] ?? "localhost", () => {
  console.log(`Listening on port ${port}`);
});
