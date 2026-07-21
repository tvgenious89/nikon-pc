/* Preview processing worker: runs the pixel pipeline off the main thread. */
importScripts('core.js');

self.onmessage = e => {
  const { seq, buffer, width, height, settings } = e.data;
  const data = new Uint8ClampedArray(buffer);
  NPCCore.processImageData(data, width, height, settings);
  self.postMessage({ seq, buffer: data.buffer, width, height }, [data.buffer]);
};
