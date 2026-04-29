export async function playPcm24k(bytes: Uint8Array) {
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  const float32Data = new Float32Array(bytes.length / 2);
  
  // PCM 16-bit signed integer to Float32
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < float32Data.length; i++) {
    const s16 = view.getInt16(i * 2, true); // Little endian
    float32Data[i] = s16 / 32768;
  }

  const buffer = audioCtx.createBuffer(1, float32Data.length, 24000);
  buffer.getChannelData(0).set(float32Data);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start();
  
  return new Promise<void>((resolve) => {
    source.onended = () => {
      audioCtx.close();
      resolve();
    };
  });
}
