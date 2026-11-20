import { AudioClassifier } from './vendor/music/audio_bundle.mjs';
import { musicKind } from './music.js';

const asset = file => new URL('./vendor/music/' + file, import.meta.url).href;
const classifier = await AudioClassifier.createFromOptions({
  wasmLoaderPath: asset('audio_wasm_module_internal.js'),
  wasmBinaryPath: asset('audio_wasm_module_internal.wasm'),
}, { baseOptions: { modelAssetPath: asset('yamnet.tflite') }, maxResults: 30 });

self.onmessage = ({ data: { samples, rate, revision } }) => {
  const [result] = classifier.classify(samples, rate);
  const cats = result?.classifications?.[0]?.categories || [];
  const score = name => cats.find(c => c.categoryName === name)?.score || 0;
  const musicForeground = score('Music') >= .75 && score('Speech') < .08 && score('Conversation') < .08;
  self.postMessage({ kind: musicKind(cats), musicForeground, revision });
};
self.postMessage({ ready: true });
