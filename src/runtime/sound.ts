import { effect as rawEffect, signal } from '@preact/signals-core';
import { openScreens } from './screens';
import { own } from './scope';

export interface SoundOptions {
  /** 0 to 1, multiplied with `sound.volume`. Default: 1. */
  volume?: number;
  /** Playback speed, which also shifts the pitch. Default: 1. */
  rate?: number;
  /**
   * Lets the sound play on after the component that started it is removed, as a closing sound
   * has to. A loop that is kept plays until the function it returned is called.
   */
  keep?: boolean;
}

const urls: Record<string, string> = {};
const buffers = new Map<string, Promise<AudioBuffer>>();
const volume = /* @__PURE__ */ signal(1);
const muted = /* @__PURE__ */ signal(false);

let context: AudioContext | undefined;
let master: GainNode;
let playing = 0;

/** An idle audio context still drives the audio device, so it is suspended while nothing plays. */
function rest(): void {
  if (context && !playing && !openScreens.value) context.suspend();
}

function output(): AudioContext {
  if (!context) {
    context = new AudioContext();
    master = context.createGain();
    master.connect(context.destination);
    rawEffect(() => {
      master.gain.value = muted.value ? 0 : volume.value;
    });
    rawEffect(rest);
  }
  return context;
}

function load(name: string): Promise<AudioBuffer> {
  let buffer = buffers.get(name);
  if (!buffer) {
    const url = urls[name];
    buffer = url
      ? fetch(url)
          .then((response) => response.arrayBuffer())
          .then((data) => output().decodeAudioData(data))
      : Promise.reject(new Error(`[nexus] sound "${name}" is not registered`));
    buffers.set(name, buffer);
  }
  return buffer;
}

function start(name: string, options: SoundOptions, loop: boolean): () => void {
  const audio = output();
  let source: AudioBufferSourceNode | undefined;
  let stopped = false;

  const end = (): void => {
    if (stopped) return;
    stopped = true;
    if (source) {
      source.onended = null;
      source.stop();
      playing--;
      rest();
    }
  };
  const stop = options.keep ? end : own(end);

  load(name).then((buffer) => {
    if (stopped) return;
    source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = options.rate ?? 1;
    const gain = audio.createGain();
    gain.gain.value = options.volume ?? 1;
    source.connect(gain).connect(master);
    source.onended = stop;
    playing++;
    audio.resume();
    source.start();
  });

  return stop;
}

/**
 * Sound effects through Web Audio. A file is fetched and decoded once, however often it plays.
 * A sound started by a component stops when that component is removed, so nothing keeps playing
 * after its screen has closed.
 *
 * @example
 * sound.register({ click: './sounds/click.ogg', engine: './sounds/engine.ogg' });
 * sound.play('click', { volume: 0.6 });
 * const stop = sound.loop('engine');
 */
export const sound = {
  /** Names sound files and starts loading them. */
  register(sounds: Record<string, string>): void {
    Object.assign(urls, sounds);
    for (const name in sounds) load(name);
  },
  /** Plays a sound once. The returned function stops it early. */
  play: (name: string, options: SoundOptions = {}): (() => void) => start(name, options, false),
  /** Plays a sound in a loop until the returned function is called or its owner is removed. */
  loop: (name: string, options: SoundOptions = {}): (() => void) => start(name, options, true),
  /** Master volume, 0 to 1. */
  volume,
  /** Silences everything without losing the volume. */
  muted,
};
