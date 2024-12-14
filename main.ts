import "./style.css";
import { Peer, DataConnection } from "peerjs";
import $ from "jquery";

class State {
  play: boolean = false;
  pos: number = 0;

  public static eq(a: State, b: State): boolean {
    return a.play === b.play && a.pos === b.pos;
  }
}

type PeersMessage = {
  type: "peers";
  peers: Array<string>;
};

type StateMessage = {
  type: "state";
  state: State;
};

type ChunkMessage = {
  type: "chunk";
  data: Uint8Array;
};

type Message = PeersMessage | StateMessage | ChunkMessage;

let state = new State();

let connections = new Map<string, DataConnection>();

const peer = new Peer();

const player = document.querySelector("#video")! as HTMLVideoElement;
const defaultVideoURL = "https://box.open-desk.net/Big Buck Bunny [YE7VzlLtp-4].mp4";

let mediaSource = new MediaSource();
let sourceBuffer: SourceBuffer;
let bufferQueue: Uint8Array[] = []; // Warteschlange für Chunks


// Default source
player.src = defaultVideoURL;
// Fallback
player.addEventListener("error", () => {
  console.error("Error loading video. Using default source.");
  player.src = defaultVideoURL;
});

mediaSource.addEventListener("sourceopen", () => {
  const mimeCodec = 'video/webm; codecs="vp8, vorbis"';
  if (!MediaSource.isTypeSupported(mimeCodec)) {
    console.error("Unsupported MIME type or codec:", mimeCodec);
    return;
  }
  sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

sourceBuffer.addEventListener("updateend", () => {
  console.log("Buffer updated, processing next chunk.");

  processBufferQueue(); // Verarbeite weitere Chunks
});
});

function on_data(conn: DataConnection, msg: Message) {
  console.log("Data", conn.peer, msg);

  switch (msg.type) {
    case "peers":
      console.log("Recv peers", msg.peers);

      for (const id of msg.peers) {
        if (connections.has(id)) {
          continue;
        }
        const conn = peer.connect(id);
        on_connect(conn);
      }
      break;

    case "state":
      if (State.eq(msg.state, state)) {
        break;
      }

      state = msg.state;

      player.currentTime = state.pos;

      if (!player.paused && !state.play) {
        player.pause();
      }

      if (player.paused && state.play) {
        player.play();
      }
      break;

    case "chunk":
      onChunkReceived(msg.data);
      break;
  }
}

function on_connect(conn: DataConnection) {
  function update() {
    let peers = "";
    for (let x of connections.keys()) {
      peers += `${x}\n`;
    }
    $("#peers").text(peers);
  }

  conn.on("open", () => {
    console.log("Connected to " + conn.peer);

    conn.send({
      type: "peers",
      peers: [...connections.keys()],
    });
    connections.set(conn.peer, conn);
    update();
  });

  conn.on("close", () => {
    console.log("Disconnected from " + conn.peer);
    connections.delete(conn.peer);
    update();
  });

  conn.on("data", (msg) => {
    on_data(conn, msg as Message);
  });
}

peer.on("open", () => {
  console.log("ID", peer.id);

  $("#link").attr("href", `/#${peer.id}`);

  if (window.location.hash) {
    const id = window.location.hash.substring(1);
    console.log("Connecting to seed:", id);

    const conn = peer.connect(id);
    on_connect(conn);
  }
});

peer.on("connection", (conn) => {
  console.log("Got connection from ", conn.peer);

  on_connect(conn);
});

function broadcast_state() {
  const next = new State();
  next.play = !player.paused;
  next.pos = player.currentTime;

  if (State.eq(state, next)) {
    return;
  }

  state = next;

  const msg = {
    type: "state",
    state: state,
  };

  for (const conn of connections.values()) {
    conn.send(msg);
  }
}

function onChunkReceived(chunk: Uint8Array) {
  if (!sourceBuffer || mediaSource.readyState !== "open") {
    console.warn("SourceBuffer or MediaSource not ready. Resetting.");
    resetMediaSourceCompletely();
  }

  bufferQueue.push(chunk); // Chunk zur Warteschlange hinzufügen
  console.log("received chunk", chunk.length);
  processBufferQueue();
}



function processBufferQueue() {
  console.log("Processing buffer queue...");
  if (!sourceBuffer) {
    console.error("SourceBuffer is not initialized.");
    return;
  }

  if (sourceBuffer.updating) {
    console.log("SourceBuffer is updating. Retrying in 50ms...");
    setTimeout(() => processBufferQueue(), 50);
    return;
  }

  if (bufferQueue.length === 0) {
    console.log("Buffer queue is empty.");
    return;
  }

  const chunk = bufferQueue.shift()!;
  try {
    sourceBuffer.appendBuffer(chunk);
    console.log("Chunk appended successfully:", chunk.byteLength);
  } catch (error) {
    console.error("Error appending buffer:", error);
    bufferQueue.unshift(chunk); // Füge den Chunk zurück in die Warteschlange
    setTimeout(() => processBufferQueue(), 100); // Versuche es später erneut
  }
  manageBuffer();
}


function manageBuffer() {
  const currentTime = player.currentTime;
  console.log(bufferQueue.length)
  if (sourceBuffer && currentTime > 60) { // 120 Sekunden
    try {
      const removeStart = 0;
      const removeEnd = currentTime - 60;
      console.log(`Removing buffer range: ${removeStart} - ${removeEnd}`);
      sourceBuffer.remove(removeStart, removeEnd);
    } catch (error) {
      console.warn("Error removing buffer range:", error);
    }
  }
}


document.querySelector("#play")?.addEventListener("click", (event) => {
  event.preventDefault();

  const fileInput = document.querySelector("#file") as HTMLInputElement;
  const file = fileInput?.files?.item(0);

  if (!file) {
    console.warn("No file selected. Using default video source.");
    player.src = defaultVideoURL; // Fallback URL
    player.play();
    return;
  }

  resetMediaSourceCompletely(); // MediaSource zurücksetzen

  const chunkSize = 256 * 1024;
  const reader = new FileReader();
  let offset = 0;

  reader.onload = () => {
    const chunk = new Uint8Array(reader.result as ArrayBuffer);
    broadcastChunk(chunk);
    offset += chunkSize;

    if (offset < file.size) {
      readNextChunk();
    } else {
      console.log("File streaming completed.");
      const checkEndOfStream = setInterval(() => {
        if (!bufferQueue.length && !sourceBuffer.updating) {
          console.log("Ending MediaSource stream.");
          mediaSource.endOfStream();
          clearInterval(checkEndOfStream);
        }
      }, 100);
    }
  };

  function readNextChunk() {
    if (bufferQueue.length > 10) {
      console.log("Buffer queue full. Waiting before loading more chunks...");
      setTimeout(() => readNextChunk(), 1000);
      return;
    }
    if (!file) {
      console.error("No file selected.");
      return;
    }
    const slice = file.slice(offset, offset + chunkSize);
    reader.readAsArrayBuffer(slice);
  }

  readNextChunk();
});



function broadcastChunk(chunk: Uint8Array) {
  // Lokales Einfügen
  console.log("Appending chunk locally for the initiator.");
  onChunkReceived(chunk);

  // Sende den Chunk an verbundene Peers
  for (const conn of connections.values()) {
    console.log(`Sending chunk to peer: ${conn.peer}`);
    conn.send({
      type: "chunk",
      data: chunk,
    });
  }
}

function resetMediaSourceCompletely() {
  if (mediaSource.readyState === "open") {
    try {
      mediaSource.endOfStream();
      console.log("MediaSource stream ended.");
    } catch (err) {
      console.warn("Error ending MediaSource stream:", err);
    }
  }

  // Remove the existing sourceBuffer if it exists
  if (sourceBuffer) {
    try {
      mediaSource.removeSourceBuffer(sourceBuffer);
      console.log("SourceBuffer removed.");
    } catch (err) {
      console.warn("Error removing SourceBuffer:", err);
    }
  }

  // Create a new MediaSource
  mediaSource = new MediaSource();
  bufferQueue = []; // Clear buffer queue

  player.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener("sourceopen", () => {
    const mimeCodec = 'video/webm; codecs="vp8, vorbis"';
    if (!MediaSource.isTypeSupported(mimeCodec)) {
      console.error("Unsupported MIME type or codec:", mimeCodec);
      return;
    }

    try {
      sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

      sourceBuffer.addEventListener("updateend", () => {
        console.log("Buffer updated, processing next chunk.");
        processBufferQueue();
      });
    } catch (err) {
      console.error("Error creating SourceBuffer:", err);
    }
  });
}



player.addEventListener("play", () => {
  console.log("Player is playing.");
  broadcast_state();
});

player.addEventListener("pause", () => {
  console.log("Player is paused.");
  broadcast_state();
});
player.addEventListener("seeked", () => broadcast_state());

window.addEventListener("resize", () => {
  const videoContainer = document.querySelector(".video-container") as HTMLDivElement;
  if (videoContainer) {
    const aspectRatio = 16 / 9;
    const width = Math.min(window.innerWidth * 0.9, 800);
    videoContainer.style.width = `${width}px`;
    videoContainer.style.height = `${width / aspectRatio}px`;
  }
});

