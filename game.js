import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as CANNON from 'cannon-es';

// ============================================================================
// 1. VERSÃO, ESCALA REALISTA E PARÂMETROS DO OPEL CORSA B 1998 (FWD)
// ============================================================================
const GAME_VERSION = '1.06';
const CITY_SCALE = 1.0;         // San Francisco já está em escala métrica real 1:1 (ruas de 15m/30m)
const CAR_SCALE = 1.05;         // Escala real proporcional do Opel Corsa B 1998 em San Francisco
const WORLD_SPEED_SCALE = 0.55; // Ritmo físico natural para avenidas, pontes e ladeiras reais

// Grupos de colisão (bitmasks) para isolar carroceria do asfalto (sem pulinhos)
const COLLISION_GROUND = 1;
const COLLISION_CHASSIS = 2;
const COLLISION_WALLS = 4;

// Pontos de Spawn verificados diretamente sobre o asfalto plano (ny = 1.0) de San Francisco
const SPAWN_POINTS = [
  {
    name: 'PONTE GOLDEN GATE',
    pos: new THREE.Vector3(-148.87, 84.42, 319.09),
    yaw: Math.PI * 0.5 // Alinhado para -X em direção à Ponte Golden Gate
  },
  {
    name: 'AVENIDA CENTRAL',
    pos: new THREE.Vector3(166.13, 84.42, 274.09),
    yaw: 0
  },
  {
    name: 'PORTO SUL (ORLA)',
    pos: new THREE.Vector3(46.14, 42.10, -355.84),
    yaw: 0
  },
  {
    name: 'ZONA DOS TÚNEIS',
    pos: new THREE.Vector3(121.10, 42.10, -355.84),
    yaw: 0
  }
];

const CORSA_SPECS = {
  mass: 920,                              // Massa real em ordem de marcha (Opel Corsa B 1.6 16V)
  wheelRadius: 0.2854 * CAR_SCALE,        // metros (~0.2997m)
  IdleRPM: 850,
  MaxRPM: 6800,
  RedlineRPM: 6500,
  ShiftUpRPM: 6150,
  ShiftDownRPM: 2700,
  // Limites de velocidade máxima no velocímetro por marcha (Original Aspirado vs Câmbio Longo no Modo Turbo):
  gearMaxSpeedKmh: {
    '-1': 28,
    '0': 0,
    '1': 20,
    '2': 50,
    '3': 90,
    '4': 120,
    '5': 180
  },
  gearMaxSpeedKmhTurbo: {
    '-1': 38,
    '0': 0,
    '1': 55,
    '2': 98,
    '3': 142,
    '4': 185,
    '5': 235
  },
  // Força de tração calibrada para 920kg reais (subidas de San Francisco e aceleração progressiva realista)
  gearDriveForces: {
    '-1': -1460,
    '0': 0,
    '1': 1720,
    '2': 1400,
    '3': 1140,
    '4': 960,
    '5': 830
  },
  maxSteerAngle: 0.50,                    // ~28.5 graus em baixa velocidade
  // Suspensão MacPherson dianteira (motor transversal) + eixo de torção traseiro com curso real
  frontSuspensionStiffness: 24.5,
  rearSuspensionStiffness: 20.5,
  suspensionRestLength: 0.34 * CAR_SCALE,
  maxSuspensionTravel: 0.24 * CAR_SCALE,
  frontDampingCompression: 3.1,
  frontDampingRelaxation: 4.1,
  rearDampingCompression: 2.8,
  rearDampingRelaxation: 3.6,
  frontAntiRollStiffness: 9200,           // Barra estabilizadora dianteira (N/m) — segura sem matar o balanço natural
  rearAntiRollStiffness: 6800,            // Barra estabilizadora traseira (N/m) — permite transferência lateral viva
  rollInfluence: 0.24,                    // Mantém inclinação lateral expressiva sem descarregar a traseira no drift
  frictionSlipNormal: 1.68,               // Coeficiente de atrito estático de pneu radial no asfalto seco
  frictionSlipHandbrake: 1.26             // Atrito cinético equilibrado das rodas traseiras no drift de freio de mão
};

// No modelo original do Corsa (onde Y apontava para baixo), aplicamos rotação de 180° em Z
// (x' = -x, y' = -y, z' = z) multiplicada por CAR_SCALE para colocá-lo em pé SEM ESPELHAR.
const WHEEL_HUBS_LOCAL = [
  { id: 'FL', isFront: true,  rawCenter: new THREE.Vector3( 75.37, -28.54, -113.89), pos: new THREE.Vector3(-0.7537 * CAR_SCALE, 0.2854 * CAR_SCALE, -1.1389 * CAR_SCALE) }, // 0: Dianteira Esquerda
  { id: 'FR', isFront: true,  rawCenter: new THREE.Vector3(-75.37, -28.54, -113.89), pos: new THREE.Vector3( 0.7537 * CAR_SCALE, 0.2854 * CAR_SCALE, -1.1389 * CAR_SCALE) }, // 1: Dianteira Direita
  { id: 'RL', isFront: false, rawCenter: new THREE.Vector3( 75.37, -28.54,  129.57), pos: new THREE.Vector3(-0.7537 * CAR_SCALE, 0.2854 * CAR_SCALE,  1.2957 * CAR_SCALE) }, // 2: Traseira Esquerda
  { id: 'RR', isFront: false, rawCenter: new THREE.Vector3(-75.37, -28.54,  129.57), pos: new THREE.Vector3( 0.7537 * CAR_SCALE, 0.2854 * CAR_SCALE,  1.2957 * CAR_SCALE) }  // 3: Traseira Direita
];

// ============================================================================
// 2. ESTADO GLOBAL DA SIMULAÇÃO
// ============================================================================
const GRAPHICS_PRESETS = {
  low: {
    key: 'low',
    label: 'BAIXO',
    pixelRatio: 0.70,
    shadows: false,
    shadowType: THREE.BasicShadowMap,
    shadowSize: 512,
    shadowDist: 14,
    reflections: 'off',
    envResolution: [128, 64],
    clearcoat: false,
    realtimeCube: false,
    maxSmokeParticles: 35,
    maxSkidSegments: 280,
    cameraFar: 320,
    fogMult: 1.85
  },
  medium: {
    key: 'medium',
    label: 'MÉDIO',
    pixelRatio: 1.0,
    shadows: true,
    shadowType: THREE.PCFShadowMap,
    shadowSize: 1024,
    shadowDist: 16,
    reflections: 'sky',
    envResolution: [512, 256],
    clearcoat: false,
    realtimeCube: false,
    maxSmokeParticles: 160,
    maxSkidSegments: 640,
    cameraFar: 620,
    fogMult: 1.05
  },
  high: {
    key: 'high',
    label: 'ALTO',
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
    shadows: true,
    shadowType: THREE.PCFSoftShadowMap,
    shadowSize: 2048,
    shadowDist: 22,
    reflections: 'clearcoat',
    envResolution: [1024, 512],
    clearcoat: true,
    realtimeCube: false,
    maxSmokeParticles: 260,
    maxSkidSegments: 1050,
    cameraFar: 850,
    fogMult: 1.0
  },
  ultra: {
    key: 'ultra',
    label: 'ULTRA',
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2.0),
    shadows: true,
    shadowType: THREE.PCFSoftShadowMap,
    shadowSize: 4096,
    shadowDist: 28,
    reflections: 'realtime',
    envResolution: [1024, 512],
    clearcoat: true,
    realtimeCube: true,
    maxSmokeParticles: 320,
    maxSkidSegments: 1400,
    cameraFar: 1000,
    fogMult: 0.90
  }
};

function getSavedGraphicsQuality() {
  try {
    const saved = localStorage.getItem('corsa3d_graphics');
    if (saved && GRAPHICS_PRESETS[saved]) return saved;
  } catch (e) {}
  return 'high';
}

const corsaReflectiveMaterials = {
  paint: [],
  glass: [],
  chrome: []
};
const cityTrackedMaterials = new Set();

const AUDIO_DEFAULTS = { master: 0.85, engine: 1.0, turbo: 0.90, tires: 0.95 };

function getSavedAudioSettings() {
  try {
    const raw = localStorage.getItem('corsa3d_audio');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        master: THREE.MathUtils.clamp(Number(parsed.master ?? AUDIO_DEFAULTS.master), 0, 1),
        engine: THREE.MathUtils.clamp(Number(parsed.engine ?? AUDIO_DEFAULTS.engine), 0, 1),
        turbo: THREE.MathUtils.clamp(Number(parsed.turbo ?? AUDIO_DEFAULTS.turbo), 0, 1),
        tires: THREE.MathUtils.clamp(Number(parsed.tires ?? AUDIO_DEFAULTS.tires), 0, 1)
      };
    }
  } catch (e) {}
  return { ...AUDIO_DEFAULTS };
}

const DEFAULT_KEYBINDS = {
  accelerate: 'KeyW',
  brake: 'KeyS',
  steerLeft: 'KeyA',
  steerRight: 'KeyD',
  handbrake: 'Space',
  gearUp: 'Equal',
  gearDown: 'Minus',
  transmission: 'KeyM',
  turbo: 'KeyT',
  absToggle: 'KeyB',
  tcsToggle: 'KeyK',
  headlights: 'KeyL',
  timeOfDay: 'KeyH',
  ignition: 'KeyI',
  camera: 'KeyC',
  reset: 'KeyR'
};

const KEYBIND_LABELS = [
  { action: 'accelerate', label: 'Acelerar' },
  { action: 'brake', label: 'Freio / Ré' },
  { action: 'steerLeft', label: 'Virar Esquerda' },
  { action: 'steerRight', label: 'Virar Direita' },
  { action: 'handbrake', label: 'Freio de Mão' },
  { action: 'gearUp', label: 'Subir Marcha' },
  { action: 'gearDown', label: 'Reduzir Marcha' },
  { action: 'transmission', label: 'Câmbio Auto/Manual' },
  { action: 'turbo', label: 'Ativar / Desativar Turbo' },
  { action: 'absToggle', label: 'Alternar Freios ABS' },
  { action: 'tcsToggle', label: 'Alternar Controle Tração (TCS)' },
  { action: 'headlights', label: 'Ligar / Desligar Faróis' },
  { action: 'timeOfDay', label: 'Alternar Dia / Noite' },
  { action: 'ignition', label: 'Motor / Ignição' },
  { action: 'camera', label: 'Trocar Câmera' },
  { action: 'reset', label: 'Reposicionar Carro' }
];

const SURFACE_PROFILES = {
  asphalt: {
    id: 'asphalt',
    label: 'ASFALTO',
    gripMul: 1.0,
    rollingMul: 1.0,
    skidVolMul: 1.0,
    skidPitchMul: 1.0,
    rumbleGain: 0.05,
    rumbleRate: 0.46,
    rumbleFreq: 340,
    smokeColorHex: 0xe6ecf2
  },
  bridge: {
    id: 'bridge',
    label: 'PONTE',
    gripMul: 0.94,
    rollingMul: 0.92,
    skidVolMul: 1.12,
    skidPitchMul: 1.14,
    rumbleGain: 0.16,
    rumbleRate: 0.56,
    rumbleFreq: 540,
    smokeColorHex: 0xe2e8f0
  },
  sidewalk: {
    id: 'sidewalk',
    label: 'CALÇADA',
    gripMul: 0.89,
    rollingMul: 1.24,
    skidVolMul: 1.18,
    skidPitchMul: 0.86,
    rumbleGain: 0.22,
    rumbleRate: 0.36,
    rumbleFreq: 420,
    smokeColorHex: 0xd6d3d1
  },
  dirt: {
    id: 'dirt',
    label: 'TERRA / GRAMA',
    gripMul: 0.68,
    rollingMul: 2.15,
    skidVolMul: 0.58,
    skidPitchMul: 0.66,
    rumbleGain: 0.26,
    rumbleRate: 0.28,
    rumbleFreq: 260,
    smokeColorHex: 0xb59e7a
  }
};

function getSavedAssistSettings() {
  try {
    const raw = localStorage.getItem('corsa3d_assists');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        abs: parsed.abs !== false,
        tcs: parsed.tcs !== false
      };
    }
  } catch (e) {}
  return { abs: true, tcs: true };
}

function getSavedKeybinds() {
  try {
    const raw = localStorage.getItem('corsa3d_keybinds');
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_KEYBINDS, ...parsed };
    }
  } catch (e) {}
  return { ...DEFAULT_KEYBINDS };
}

function formatKeyCode(code) {
  if (!code) return '---';
  if (code === 'Space') return 'ESPAÇO';
  if (code === 'Equal') return '+ / =';
  if (code === 'Minus') return '- / _';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  if (code === 'ArrowUp') return 'SETA ▲';
  if (code === 'ArrowDown') return 'SETA ▼';
  if (code === 'ArrowLeft') return 'SETA ◀';
  if (code === 'ArrowRight') return 'SETA ▶';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'SHIFT';
  if (code === 'ControlLeft' || code === 'ControlRight') return 'CTRL';
  return code.toUpperCase();
}

const state = {
  loaded: false,
  started: false,
  menuOpen: true,
  selectedMap: 'san_francisco',
  selectedCar: 'corsa_b_1998',
  audio: getSavedAudioSettings(),
  keybinds: getSavedKeybinds(),
  listeningAction: null,
  engineOn: false,
  startingEngine: false,
  timeOfDay: 'day',       // 'day', 'sunset', 'night', 'auto'
  timeHour: 12.0,
  graphicsQuality: getSavedGraphicsQuality(),
  graphicsMenuOpen: false,
  headlightsOn: false,    // Faróis dianteiros e lanternas traseiras (Tecla L ou botão HUD)
  turboInstalled: false,  // Kit Turbo com espirro de alívio nas trocas de marcha e torque extra
  turboBoost: 0.0,        // Pressão atual da turbina: 0.0 (sem pressão) a 1.0 (turbo cheio / 1.5 bar)
  transmission: 'MANUAL', // 'MANUAL' ou 'AUTO'
  gear: 1,                // -1 = R, 0 = N, 1..5 = 1ª a 5ª marcha
  shiftCooldown: 0,
  shiftDuration: 0.22,
  shiftPhase: 'none',     // 'upshift' | 'downshift' | 'none'
  clutchEngagement: 1.0,  // 0.0 (desacoplada) -> 1.0 (acoplada)
  revMatchTargetRPM: 0,
  absEnabled: getSavedAssistSettings().abs,
  tcsEnabled: getSavedAssistSettings().tcs,
  absActive: false,
  tcsActive: false,
  surfaceType: 'asphalt',
  rpm: 0,
  speedKmh: 0,
  forwardSpeedMs: 0,
  lateralSpeedMs: 0,
  longitudinalLoad: 0,
  throttleInput: 0,
  brakeInput: 0,
  handbrakeInput: 0,
  steerInput: 0,
  currentSteer: 0,
  cuttingRev: false,
  skidIntensity: 0,
  burnoutIntensity: 0,
  isDrifting: false,
  driftAngleDeg: 0,
  cameraMode: 0,          // 0: Perseguição, 1: Capô/Motor, 2: Escapamento Traseiro, 3: Órbita Livre
  spawnIdx: 0,
  orbitYaw: 0,
  orbitPitch: 0.18,
  isPointerDown: false,
  mobileMode: false,
  touchInput: {
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0
  },
  wheelSkids: [0, 0, 0, 0],
  wheelCompression: [0.5, 0.5, 0.5, 0.5]
};

const keys = {
  w: false,
  a: false,
  s: false,
  d: false,
  space: false
};

// ============================================================================
// 3. SISTEMA DE ÁUDIO ESPACIAL 3D (HRTF) COM TEXTURA ESTACIONÁRIA CONTÍNUA
// ============================================================================
function createSteadyToneBufferFromMP3(audioCtx, sourceBuffer, startSec, durationSec = 0.28, targetRMS = 0.18) {
  const sr = sourceBuffer.sampleRate;
  const numCh = sourceBuffer.numberOfChannels;
  const startIdx = Math.max(0, Math.floor(startSec * sr));
  const winLen = Math.min(sourceBuffer.length - startIdx, Math.floor(durationSec * sr));
  const halfLen = Math.floor(winLen / 2);

  const outBuffer = audioCtx.createBuffer(numCh, halfLen, sr);

  for (let ch = 0; ch < numCh; ch++) {
    const src = sourceBuffer.getChannelData(ch);
    const out = outBuffer.getChannelData(ch);

    let sumSq = 0;
    for (let i = 0; i < halfLen; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / halfLen));
      const sA = src[startIdx + i];
      const sB = src[startIdx + halfLen + i];
      const val = sA * w + sB * (1.0 - w);
      out[i] = val;
      sumSq += val * val;
    }

    const rms = Math.sqrt(sumSq / halfLen) || 1e-4;
    const scale = targetRMS / rms;
    for (let i = 0; i < halfLen; i++) {
      out[i] = Math.max(-0.95, Math.min(0.95, out[i] * scale));
    }
  }

  return outBuffer;
}

function extractSeamlessLoopBuffer(audioCtx, sourceBuffer, startSec, endSec, crossfadeSec = 0.08, gainScale = 1.0) {
  const sampleRate = sourceBuffer.sampleRate;
  const numChannels = sourceBuffer.numberOfChannels;

  const startSample = Math.max(0, Math.floor(startSec * sampleRate));
  const endSample = Math.min(sourceBuffer.length, Math.floor(endSec * sampleRate));
  const totalSamples = endSample - startSample;
  const fadeSamples = Math.min(Math.floor(crossfadeSec * sampleRate), Math.floor(totalSamples / 4));
  const outLength = totalSamples - fadeSamples;

  const outBuffer = audioCtx.createBuffer(numChannels, outLength, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const srcData = sourceBuffer.getChannelData(ch);
    const outData = outBuffer.getChannelData(ch);

    for (let i = 0; i < outLength; i++) {
      let sample = srcData[startSample + i];
      if (i < fadeSamples) {
        const alpha = i / fadeSamples;
        const tailSample = srcData[startSample + outLength + i];
        sample = sample * alpha + tailSample * (1.0 - alpha);
      }
      outData[i] = sample * gainScale;
    }
  }

  return outBuffer;
}

class SpatialCarAudio {
  constructor(camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.ctx = this.listener.context;
    this.rawBuffers = {};
    this.slicedBuffers = {};

    this.engineAnchor = new THREE.Object3D();   // Cofre do motor (Dianteira)
    this.exhaustAnchor = new THREE.Object3D();  // Ponteira do escapamento (Traseira Esquerda)
    this.tiresAnchor = new THREE.Object3D();    // Centro das rodas para o som de derrapagem

    this.sources = {};
  }

  async loadAll(onProgress) {
    const audioLoader = new THREE.AudioLoader();
    const files = [
      { key: 'start', url: './Corsa ligando.mp3' },
      { key: 'revCut', url: './Cortar giro.mp3' },
      { key: 'accel', url: './Acelerações.mp3' },
      { key: 'skid', url: './Carro derrapando.mp3' },
      { key: 'turbo', url: './turbo.mp3' }
    ];

    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      this.rawBuffers[item.key] = await new Promise((resolve) => {
        audioLoader.load(
          item.url,
          (buf) => resolve(buf),
          undefined,
          (err) => {
            console.warn(`Erro ao carregar ${item.url}:`, err);
            resolve(null);
          }
        );
      });
      if (onProgress) onProgress((i + 1) / files.length);
    }

    this.slicedBuffers.idle = createSteadyToneBufferFromMP3(this.ctx, this.rawBuffers.accel, 14.50, 0.36, 0.20);
    this.slicedBuffers.midLoad = createSteadyToneBufferFromMP3(this.ctx, this.rawBuffers.accel, 31.85, 0.30, 0.22);
    this.slicedBuffers.highLoad = createSteadyToneBufferFromMP3(this.ctx, this.rawBuffers.accel, 36.60, 0.28, 0.22);
    this.slicedBuffers.revCut = extractSeamlessLoopBuffer(this.ctx, this.rawBuffers.revCut, 2.80, 5.60, 0.06, 0.34);
    this.slicedBuffers.skid = extractSeamlessLoopBuffer(this.ctx, this.rawBuffers.skid, 0.45, 4.10, 0.08, 0.72);
  }

  createPositionalNode(anchor, refDist = 2.0, maxDist = 80, coneInner = 360, coneOuter = 360, coneGain = 1.0) {
    const sound = new THREE.PositionalAudio(this.listener);
    sound.setRefDistance(refDist);
    sound.setMaxDistance(maxDist);
    sound.setRolloffFactor(1.4);
    sound.setDistanceModel('inverse');
    sound.panner.panningModel = 'HRTF';
    sound.setDirectionalCone(coneInner, coneOuter, coneGain);
    anchor.add(sound);
    return sound;
  }

  setupNodes(chassisGroup) {
    this.engineAnchor.position.set(0.0, 0.15 * CAR_SCALE, -1.42 * CAR_SCALE);     // Cofre do motor dianteiro
    this.exhaustAnchor.position.set(-0.50 * CAR_SCALE, -0.25 * CAR_SCALE, 1.76 * CAR_SCALE); // Ponteira cromada traseira real
    this.tiresAnchor.position.set(0.0, -0.20 * CAR_SCALE, 0.0);

    chassisGroup.add(this.engineAnchor);
    chassisGroup.add(this.exhaustAnchor);
    chassisGroup.add(this.tiresAnchor);

    this.sources.starter = this.createPositionalNode(this.engineAnchor, 2.2, 60);
    this.sources.engineIdle = this.createPositionalNode(this.engineAnchor, 2.0, 75, 240, 360, 0.7);
    this.sources.engineLoad = this.createPositionalNode(this.engineAnchor, 2.4, 85, 240, 360, 0.7);
    this.sources.exhaustLoad = this.createPositionalNode(this.exhaustAnchor, 2.4, 100, 180, 340, 0.55);
    this.sources.revCutExhaust = this.createPositionalNode(this.exhaustAnchor, 2.2, 90, 180, 340, 0.6);
    this.sources.revCutEngine = this.createPositionalNode(this.engineAnchor, 1.8, 75);
    this.sources.skid = this.createPositionalNode(this.tiresAnchor, 2.2, 90);
    this.sources.roadRumble = this.createPositionalNode(this.tiresAnchor, 1.8, 70);
    try {
      this.roadRumbleFilter = this.ctx.createBiquadFilter();
      this.roadRumbleFilter.type = 'lowpass';
      this.roadRumbleFilter.frequency.setValueAtTime(360, this.ctx.currentTime);
      this.sources.roadRumble.setFilter(this.roadRumbleFilter);
    } catch (e) {}
    this.sources.turbo = this.createPositionalNode(this.engineAnchor, 3.2, 95);
    if (this.rawBuffers.turbo) {
      this.sources.turbo.setBuffer(this.rawBuffers.turbo);
      this.sources.turbo.setLoop(false);
    }
    this.sources.turboWhistle = this.createPositionalNode(this.engineAnchor, 2.2, 70);
  }

  initTurboWhistleSynth() {
    if (this.turboWhistleInitialized) return;
    this.turboWhistleInitialized = true;

    try {
      // [1] Oscilador senoidal suave e aveludado (assovio macio de turbina, sem estridência)
      this.turboOsc = this.ctx.createOscillator();
      this.turboOsc.type = 'sine';
      this.turboOsc.frequency.setValueAtTime(620, this.ctx.currentTime);
      const oscGain = this.ctx.createGain();
      oscGain.gain.setValueAtTime(0.18, this.ctx.currentTime);
      this.turboOsc.connect(oscGain);

      // [2] Filtro passa-baixas dedicado para cortar frequências agudas estridentes
      this.turboToneFilter = this.ctx.createBiquadFilter();
      this.turboToneFilter.type = 'lowpass';
      this.turboToneFilter.frequency.setValueAtTime(1600, this.ctx.currentTime);
      this.turboToneFilter.Q.setValueAtTime(0.8, this.ctx.currentTime);

      // [3] Gerador de sucção de ar suave e aveludado (ruído filtrado em passa-faixa macio)
      const bufferSize = Math.floor(this.ctx.sampleRate * 2);
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.18;
      }
      this.turboNoise = this.ctx.createBufferSource();
      this.turboNoise.buffer = noiseBuffer;
      this.turboNoise.loop = true;

      this.turboAirFilter = this.ctx.createBiquadFilter();
      this.turboAirFilter.type = 'bandpass';
      this.turboAirFilter.Q.setValueAtTime(2.4, this.ctx.currentTime);
      this.turboAirFilter.frequency.setValueAtTime(780, this.ctx.currentTime);

      const airGain = this.ctx.createGain();
      airGain.gain.setValueAtTime(0.20, this.ctx.currentTime);
      this.turboNoise.connect(airGain);
      airGain.connect(this.turboAirFilter);

      // Ganho mestre do assovio do turbo (calibrado para ser sutil e mais baixo)
      this.turboMasterGain = this.ctx.createGain();
      this.turboMasterGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

      oscGain.connect(this.turboToneFilter);
      this.turboAirFilter.connect(this.turboToneFilter);
      this.turboToneFilter.connect(this.turboMasterGain);

      // Conecta no Three.js PositionalAudio ancorado no cofre do motor
      if (this.sources.turboWhistle && this.sources.turboWhistle.gain) {
        this.turboMasterGain.connect(this.sources.turboWhistle.gain);
      }

      this.turboOsc.start();
      this.turboNoise.start();
    } catch (err) {
      console.warn('Erro ao inicializar sintetizador de assovio do turbo:', err);
    }
  }

  startContinuousLoops() {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.initTurboWhistleSynth();

    this.startSlicedLoop(this.sources.engineIdle, this.slicedBuffers.idle);
    this.startSlicedLoop(this.sources.engineLoad, this.slicedBuffers.midLoad);
    this.startSlicedLoop(this.sources.exhaustLoad, this.slicedBuffers.highLoad);
    this.startSlicedLoop(this.sources.revCutExhaust, this.slicedBuffers.revCut);
    this.startSlicedLoop(this.sources.revCutEngine, this.slicedBuffers.revCut);
    this.startSlicedLoop(this.sources.skid, this.slicedBuffers.skid);
    this.startSlicedLoop(this.sources.roadRumble, this.slicedBuffers.skid);
  }

  startSlicedLoop(posAudio, slicedBuffer) {
    if (!slicedBuffer) return;
    if (posAudio.isPlaying) posAudio.stop();
    posAudio.setBuffer(slicedBuffer);
    posAudio.setLoop(true);
    posAudio.setVolume(0.0);
    posAudio.play();
  }

  triggerIgnition(onComplete) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const starter = this.sources.starter;
    if (starter.isPlaying) starter.stop();
    starter.setBuffer(this.rawBuffers.start);
    starter.setLoop(false);
    starter.setVolume(0.85 * state.audio.master * state.audio.engine);
    starter.setPlaybackRate(1.0);
    starter.offset = 0.05;
    starter.play();

    setTimeout(() => {
      if (onComplete) onComplete();
    }, 1050);
  }

  playTurboBlowOff() {
    if (!state.turboInstalled) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const turboNode = this.sources.turbo;
    if (!turboNode || !this.rawBuffers.turbo) return;

    if (!turboNode.buffer) {
      turboNode.setBuffer(this.rawBuffers.turbo);
    }
    if (turboNode.isPlaying) {
      try {
        turboNode.stop();
      } catch (e) {}
    }
    turboNode.setLoop(false);
    turboNode.setVolume(1.0 * state.audio.master * state.audio.turbo);
    // Variação leve e realista de pitch dependendo da rotação do motor na troca de marcha
    const pitch = THREE.MathUtils.clamp(0.94 + (state.rpm / CORSA_SPECS.MaxRPM) * 0.16, 0.90, 1.15);
    turboNode.setPlaybackRate(pitch);
    turboNode.play();
  }

  shutDownEngine() {
    const now = this.ctx.currentTime;
    ['engineIdle', 'engineLoad', 'exhaustLoad', 'revCutExhaust', 'revCutEngine'].forEach((k) => {
      const s = this.sources[k];
      if (s && s.gain) {
        s.gain.gain.setTargetAtTime(0.0, now, 0.08);
      }
    });
    if (this.turboMasterGain) {
      this.turboMasterGain.gain.setTargetAtTime(0.0, now, 0.05);
    }
  }

  update() {
    if (!this.sources.engineIdle || !this.sources.engineIdle.isPlaying) return;
    const now = this.ctx.currentTime;
    const masterGain = state.audio.master;
    const engGain = masterGain * state.audio.engine;
    const turboGain = masterGain * state.audio.turbo;
    const tireGain = masterGain * state.audio.tires;

    const surfProfile = SURFACE_PROFILES[state.surfaceType] || SURFACE_PROFILES.asphalt;
    const skidVol = THREE.MathUtils.clamp(state.skidIntensity * 0.72 * surfProfile.skidVolMul, 0, 0.85) * tireGain;
    const skidPitch = THREE.MathUtils.clamp((0.90 + state.skidIntensity * 0.20 + (state.speedKmh / 220) * 0.12) * surfProfile.skidPitchMul, 0.58, 1.38);
    this.sources.skid.gain.gain.setTargetAtTime(skidVol, now, 0.04);
    if (this.sources.skid.source) {
      this.sources.skid.source.playbackRate.setTargetAtTime(skidPitch, now, 0.05);
    }

    // Textura sonora de rolagem por tipo de superfície (Asfalto, Ponte, Calçada, Terra)
    if (this.sources.roadRumble && this.sources.roadRumble.gain) {
      let wheelsGrounded = 0;
      if (typeof vehicle !== 'undefined' && vehicle) {
        for (let w = 0; w < 4; w++) {
          if (vehicle.wheelInfos[w] && vehicle.wheelInfos[w].isInContact) wheelsGrounded++;
        }
      }
      const rollingSpeedFactor = THREE.MathUtils.clamp((state.speedKmh - 8) / 85, 0, 1.0);
      const rumbleVol = surfProfile.rumbleGain * rollingSpeedFactor * (wheelsGrounded * 0.25) * tireGain;
      this.sources.roadRumble.gain.gain.setTargetAtTime(rumbleVol, now, 0.06);
      if (this.sources.roadRumble.source) {
        this.sources.roadRumble.source.playbackRate.setTargetAtTime(
          surfProfile.rumbleRate + rollingSpeedFactor * 0.18,
          now,
          0.08
        );
      }
      if (this.roadRumbleFilter) {
        this.roadRumbleFilter.frequency.setTargetAtTime(surfProfile.rumbleFreq, now, 0.08);
      }
    }

    if (!state.engineOn) {
      this.shutDownEngine();
      return;
    }

    // ========================================================================
    // ASSOVIO DO TURBO ENCHENDO (SUTIL, MACIO E MAIS BAIXO)
    // ========================================================================
    if (this.turboMasterGain) {
      if (state.engineOn && state.turboInstalled && state.turboBoost > 0.04) {
        // Conforme a turbina enche (0.0 a 1.0), o tom sobe suavemente de 620 Hz até 1.350 Hz
        const basePitchHz = 620 + state.turboBoost * 620 + (state.rpm / CORSA_SPECS.MaxRPM) * 140;
        this.turboOsc.frequency.setTargetAtTime(basePitchHz, now, 0.05);

        if (this.turboAirFilter) {
          this.turboAirFilter.frequency.setTargetAtTime(720 + state.turboBoost * 580, now, 0.05);
        }

        // Volume sutil, equilibrado e bem mais baixo que o ronco do motor
        const boostVol = Math.pow(state.turboBoost, 1.5) * 0.15 * (0.30 + state.throttleInput * 0.70) * turboGain;
        this.turboMasterGain.gain.setTargetAtTime(boostVol, now, 0.045);
      } else {
        this.turboMasterGain.gain.setTargetAtTime(0.0, now, 0.035);
      }
    }

    const rpmNorm = THREE.MathUtils.clamp((state.rpm - CORSA_SPECS.IdleRPM) / (CORSA_SPECS.MaxRPM - CORSA_SPECS.IdleRPM), 0, 1);
    const throttle = state.throttleInput;

    const idlePitch = 0.96 + rpmNorm * 0.85;
    const idleVol = THREE.MathUtils.clamp((1.0 - rpmNorm * 0.75) * 0.70, 0.12, 0.72) * engGain;
    this.sources.engineIdle.gain.gain.setTargetAtTime(idleVol, now, 0.04);
    if (this.sources.engineIdle.source) {
      this.sources.engineIdle.source.playbackRate.setTargetAtTime(idlePitch, now, 0.035);
    }

    const cutAttenuation = state.cuttingRev ? 0.28 : 1.0;

    const midPitch = 0.58 + rpmNorm * 1.15;
    const midVol = THREE.MathUtils.clamp((rpmNorm * 0.75 + throttle * 0.25) * 0.72 * cutAttenuation, 0.0, 0.75) * engGain;
    this.sources.engineLoad.gain.gain.setTargetAtTime(midVol, now, 0.035);
    if (this.sources.engineLoad.source) {
      this.sources.engineLoad.source.playbackRate.setTargetAtTime(midPitch, now, 0.03);
    }

    const highPitch = 0.55 + rpmNorm * 1.12;
    const highVol = THREE.MathUtils.clamp(Math.pow(rpmNorm, 1.1) * (0.50 + throttle * 0.45) * 0.78 * cutAttenuation, 0.0, 0.82) * engGain;
    this.sources.exhaustLoad.gain.gain.setTargetAtTime(highVol, now, 0.035);
    if (this.sources.exhaustLoad.source) {
      this.sources.exhaustLoad.source.playbackRate.setTargetAtTime(highPitch, now, 0.03);
    }

    const revCutVol = (state.cuttingRev ? 0.42 : 0.0) * engGain;
    this.sources.revCutExhaust.gain.gain.setTargetAtTime(revCutVol, now, 0.025);
    this.sources.revCutEngine.gain.gain.setTargetAtTime(revCutVol * 0.60, now, 0.025);
  }
}

// ============================================================================
// 4. SISTEMA DE PARTÍCULAS 3D EM LOTE (FUMAÇA VOLUMÉTRICA PROCEDURAL & MARCAS DE PNEU)
// ============================================================================
function createProceduralSmokeAtlasTexture() {
  const size = 256;
  const half = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  const hash2 = (ix, iy, seed) => {
    const h = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453123;
    return h - Math.floor(h);
  };

  const smoothNoise = (x, y, seed) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed);
    const b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed);
    const d = hash2(ix + 1, iy + 1, seed);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };

  const fbm = (x, y, seed) => {
    let v = 0;
    v += smoothNoise(x, y, seed) * 0.55;
    v += smoothNoise(x * 2.15 + 7.3, y * 2.15 + 3.1, seed + 11) * 0.30;
    v += smoothNoise(x * 4.4 + 19.7, y * 4.4 + 13.4, seed + 29) * 0.15;
    return v;
  };

  for (let q = 0; q < 4; q++) {
    const qx = (q % 2) * half;
    const qy = Math.floor(q / 2) * half;
    const seed = 13.7 + q * 31.3;

    for (let py = 0; py < half; py++) {
      for (let px = 0; px < half; px++) {
        const nx = (px - 63.5) / 54.0;
        const ny = (py - 63.5) / 54.0;
        const r2 = nx * nx + ny * ny;
        if (r2 >= 1.0) continue;

        // Distorção orgânica dos lóbulos da nuvem com ruído FBM multi-oitava
        const warp = fbm(nx * 2.4 + 4.0, ny * 2.4 + 4.0, seed);
        const rWarped = Math.sqrt(r2) - (warp - 0.5) * 0.34;
        const radialMask = Math.max(0, 1.0 - rWarped * rWarped);
        const softMask = Math.pow(radialMask, 1.9);

        const detail = fbm(nx * 3.8 + warp * 1.4, ny * 3.8 - warp * 1.1, seed + 53);
        const alpha = Math.min(1.0, softMask * (0.45 + 0.85 * detail));
        const highlight = Math.min(255, Math.round(226 + detail * 28));

        const idx = ((qy + py) * size + (qx + px)) * 4;
        data[idx] = highlight;
        data[idx + 1] = highlight;
        data[idx + 2] = Math.min(255, highlight + 4);
        data[idx + 3] = Math.round(alpha * 228);
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

class SmokeParticleSystem {
  constructor(scene, maxParticles = 360) {
    this.maxParticles = maxParticles;
    this.activeLimit = maxParticles;
    this.pool = [];
    this.index = 0;

    const texture = createProceduralSmokeAtlasTexture();
    const vertCount = maxParticles * 4;
    this.positions = new Float32Array(vertCount * 3);
    this.uvs = new Float32Array(vertCount * 2);
    this.colors = new Float32Array(vertCount * 4);
    const indices = new Uint16Array(maxParticles * 6);

    for (let i = 0; i < maxParticles; i++) {
      const vb = i * 4;
      const ib = i * 6;
      indices[ib] = vb;
      indices[ib + 1] = vb + 1;
      indices[ib + 2] = vb + 2;
      indices[ib + 3] = vb;
      indices[ib + 4] = vb + 2;
      indices[ib + 5] = vb + 3;

      this.pool.push({
        active: false,
        age: 0,
        maxAge: 1.0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        startScale: 0.2,
        endScale: 1.5,
        startOpacity: 0.4,
        buoyancy: 0.55,
        drag: 0.42,
        rotSpeed: 0,
        rotZ: 0,
        curlPhase: Math.random() * Math.PI * 2,
        baseColor: new THREE.Color(0xe2e8f0)
      });
    }

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(this.uvs, 2);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 4);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('uv', this.uvAttr);
    this.geometry.setAttribute('color', this.colorAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide
    });

    // Um único Mesh em lote reduz centenas de draw calls de partículas para 1!
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);

    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._envTint = new THREE.Color(1, 1, 1);
  }

  setActiveLimit(limit) {
    this.activeLimit = Math.max(10, Math.min(this.maxParticles, limit));
    for (let i = this.activeLimit; i < this.maxParticles; i++) {
      this.pool[i].active = false;
    }
    this.index = this.index % this.activeLimit;
  }

  spawn(pos, vel, opts = {}) {
    const p = this.pool[this.index];
    const slot = this.index;
    this.index = (this.index + 1) % this.activeLimit;

    p.active = true;
    p.age = 0;
    p.maxAge = opts.maxAge ?? (0.9 + Math.random() * 0.7);
    p.startScale = opts.startScale ?? 0.22;
    p.endScale = opts.endScale ?? 1.85;
    p.startOpacity = opts.opacity ?? 0.42;
    p.buoyancy = opts.buoyancy ?? 0.58;
    p.drag = opts.drag ?? 0.40;
    p.rotZ = Math.random() * Math.PI * 2;
    p.rotSpeed = (Math.random() - 0.5) * 2.1;
    p.curlPhase = Math.random() * Math.PI * 2;

    p.baseColor.setHex(opts.colorHex ?? 0xe2e8f0);
    p.pos.copy(pos);
    p.vel.copy(vel);

    // Seleciona um dos 4 formatos orgânicos do atlas 2x2 com margem interna anti-sangria
    const q = Math.floor(Math.random() * 4);
    const col = q % 2;
    const row = Math.floor(q / 2);
    const pad = 0.012;
    const u0 = col * 0.5 + pad;
    const u1 = (col + 1) * 0.5 - pad;
    const v0 = 1.0 - (row + 1) * 0.5 + pad;
    const v1 = 1.0 - row * 0.5 - pad;

    const uvBase = slot * 8;
    this.uvs[uvBase] = u0; this.uvs[uvBase + 1] = v0;
    this.uvs[uvBase + 2] = u1; this.uvs[uvBase + 3] = v0;
    this.uvs[uvBase + 4] = u1; this.uvs[uvBase + 5] = v1;
    this.uvs[uvBase + 6] = u0; this.uvs[uvBase + 7] = v1;
    this.uvAttr.needsUpdate = true;
  }

  update(dt, camera) {
    this._camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this._camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    // Tonaliza a fumaça de acordo com a iluminação do ambiente (dia claro, pôr do sol quente, noite discreta)
    const sunLum = typeof sunLight !== 'undefined' ? sunLight.intensity : 1.0;
    const hemiLum = typeof hemiLight !== 'undefined' ? hemiLight.intensity : 0.7;
    const envLevel = THREE.MathUtils.clamp(0.32 + sunLum * 0.28 + hemiLum * 0.25, 0.34, 1.0);
    const isSunsetTint = typeof sunLight !== 'undefined' && sunLight.color.r > sunLight.color.b * 1.25 && sunLum > 0.2;
    this._envTint.setRGB(
      envLevel * (isSunsetTint ? 1.05 : 1.0),
      envLevel * (isSunsetTint ? 0.92 : 1.0),
      envLevel * (isSunsetTint ? 0.84 : 1.0)
    );

    const rx = this._camRight.x;
    const ry = this._camRight.y;
    const rz = this._camRight.z;
    const ux = this._camUp.x;
    const uy = this._camUp.y;
    const uz = this._camUp.z;

    let anyActive = false;
    let maxWrittenSlot = -1;

    for (let i = 0; i < this.activeLimit; i++) {
      const p = this.pool[i];
      const vBase = i * 12;
      const cBase = i * 16;

      if (!p.active) {
        this.colors[cBase + 3] = 0;
        this.colors[cBase + 7] = 0;
        this.colors[cBase + 11] = 0;
        this.colors[cBase + 15] = 0;
        continue;
      }

      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
        this.colors[cBase + 3] = 0;
        this.colors[cBase + 7] = 0;
        this.colors[cBase + 11] = 0;
        this.colors[cBase + 15] = 0;
        continue;
      }

      anyActive = true;
      maxWrittenSlot = i;

      const t = p.age / p.maxAge;
      const curl = Math.sin(p.age * 3.4 + p.curlPhase) * 0.35 * dt;
      p.pos.x += p.vel.x * dt + curl * rx;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt + curl * rz;

      const dragMul = Math.pow(p.drag, dt);
      p.vel.x *= dragMul;
      p.vel.y = p.vel.y * dragMul + p.buoyancy * dt;
      p.vel.z *= dragMul;

      const halfScale = THREE.MathUtils.lerp(p.startScale, p.endScale, Math.pow(t, 0.56)) * 0.5;
      const fadeIn = Math.min(t * 6.0, 1.0);
      const fadeOut = Math.pow(1.0 - t, 1.65);
      const alpha = p.startOpacity * fadeIn * fadeOut;

      p.rotZ += p.rotSpeed * dt;
      const c = Math.cos(p.rotZ) * halfScale;
      const s = Math.sin(p.rotZ) * halfScale;

      const ax = rx * c + ux * s;
      const ay = ry * c + uy * s;
      const az = rz * c + uz * s;

      const bx = ux * c - rx * s;
      const by = uy * c - ry * s;
      const bz = uz * c - rz * s;

      const px = p.pos.x;
      const py = p.pos.y;
      const pz = p.pos.z;

      // Vértices do quad rotacionado em câmera (BL, BR, TR, TL)
      this.positions[vBase]     = px - ax - bx; this.positions[vBase + 1]  = py - ay - by; this.positions[vBase + 2]  = pz - az - bz;
      this.positions[vBase + 3] = px + ax - bx; this.positions[vBase + 4]  = py + ay - by; this.positions[vBase + 5]  = pz + az - bz;
      this.positions[vBase + 6] = px + ax + bx; this.positions[vBase + 7]  = py + ay + by; this.positions[vBase + 8]  = pz + az + bz;
      this.positions[vBase + 9] = px - ax + bx; this.positions[vBase + 10] = py - ay + by; this.positions[vBase + 11] = pz - az + bz;

      const cr = p.baseColor.r * this._envTint.r;
      const cg = p.baseColor.g * this._envTint.g;
      const cb = p.baseColor.b * this._envTint.b;

      for (let k = 0; k < 4; k++) {
        const ci = cBase + k * 4;
        this.colors[ci] = cr;
        this.colors[ci + 1] = cg;
        this.colors[ci + 2] = cb;
        this.colors[ci + 3] = alpha;
      }
    }

    if (anyActive) {
      this.geometry.setDrawRange(0, (maxWrittenSlot + 1) * 6);
      this.posAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    } else if (this.geometry.drawRange.count !== 0) {
      this.geometry.setDrawRange(0, 0);
    }
  }
}

function createProceduralTireTreadTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(64, 64);
  const data = imgData.data;

  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const u = x / 63.0;
      const edgeFade = Math.sin(u * Math.PI);
      const softEdge = Math.pow(edgeFade, 0.55);

      // Sulcos longitudinais discretos de banda de rodagem
      const inGroove =
        (u > 0.24 && u < 0.29) ||
        (u > 0.47 && u < 0.53) ||
        (u > 0.71 && u < 0.76);
      const grooveMul = inGroove ? 0.38 : 1.0;

      const grain = 0.85 + 0.15 * Math.sin(x * 13.7 + y * 5.3);
      const alpha = THREE.MathUtils.clamp(softEdge * grooveMul * grain, 0, 1);

      const idx = (y * 64 + x) * 4;
      data[idx] = 22;
      data[idx + 1] = 24;
      data[idx + 2] = 28;
      data[idx + 3] = Math.round(alpha * 235);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

class TireSkidMarkSystem {
  constructor(scene, maxSegments = 1400) {
    this.maxSegments = maxSegments;
    this.activeLimit = maxSegments;
    this.cursor = 0;
    this.count = 0;

    const vertCount = maxSegments * 4;
    this.positions = new Float32Array(vertCount * 3);
    this.uvs = new Float32Array(vertCount * 2);
    this.colors = new Float32Array(vertCount * 4);
    const indices = new Uint16Array(maxSegments * 6);

    for (let i = 0; i < maxSegments; i++) {
      const vb = i * 4;
      const ib = i * 6;
      indices[ib] = vb;
      indices[ib + 1] = vb + 1;
      indices[ib + 2] = vb + 2;
      indices[ib + 3] = vb;
      indices[ib + 4] = vb + 2;
      indices[ib + 5] = vb + 3;
    }

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(this.uvs, 2);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 4);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('uv', this.uvAttr);
    this.geometry.setAttribute('color', this.colorAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.MeshBasicMaterial({
      map: createProceduralTireTreadTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    this.wheels = Array.from({ length: 4 }, () => ({
      hasPrev: false,
      prevPos: new THREE.Vector3(),
      prevLeft: new THREE.Vector3(),
      prevRight: new THREE.Vector3(),
      prevAlpha: 0,
      uvV: 0
    }));
    this._curPos = new THREE.Vector3();
    this._curLeft = new THREE.Vector3();
    this._curRight = new THREE.Vector3();
    this._dirty = false;
  }

  setActiveLimit(limit) {
    const nextLimit = Math.max(60, Math.min(this.maxSegments, limit));
    if (nextLimit < this.count) {
      this.clearAll();
    }
    this.activeLimit = nextLimit;
    this.cursor = this.cursor % this.activeLimit;
  }

  resetWheelLinks() {
    for (let i = 0; i < 4; i++) {
      this.wheels[i].hasPrev = false;
    }
  }

  clearAll() {
    this.cursor = 0;
    this.count = 0;
    this.colors.fill(0);
    this.geometry.setDrawRange(0, 0);
    this.colorAttr.needsUpdate = true;
    this.resetWheelLinks();
  }

  _writeSegment(w, curLeft, curRight, curAlpha, segDist) {
    const seg = this.cursor;
    this.cursor = (this.cursor + 1) % this.activeLimit;
    if (this.count < this.activeLimit) this.count++;

    const vBase = seg * 12;
    const uvBase = seg * 8;
    const cBase = seg * 16;

    const nextUvV = w.uvV + segDist * 1.4;

    // Quad contínuo no asfalto: [prevLeft, prevRight, curRight, curLeft]
    this.positions[vBase]     = w.prevLeft.x;  this.positions[vBase + 1]  = w.prevLeft.y;  this.positions[vBase + 2]  = w.prevLeft.z;
    this.positions[vBase + 3] = w.prevRight.x; this.positions[vBase + 4]  = w.prevRight.y; this.positions[vBase + 5]  = w.prevRight.z;
    this.positions[vBase + 6] = curRight.x;    this.positions[vBase + 7]  = curRight.y;    this.positions[vBase + 8]  = curRight.z;
    this.positions[vBase + 9] = curLeft.x;     this.positions[vBase + 10] = curLeft.y;     this.positions[vBase + 11] = curLeft.z;

    this.uvs[uvBase]     = 0; this.uvs[uvBase + 1] = w.uvV;
    this.uvs[uvBase + 2] = 1; this.uvs[uvBase + 3] = w.uvV;
    this.uvs[uvBase + 4] = 1; this.uvs[uvBase + 5] = nextUvV;
    this.uvs[uvBase + 6] = 0; this.uvs[uvBase + 7] = nextUvV;

    // Cores RGBA suaves para transição sem emendas
    this.colors[cBase]      = 0.10; this.colors[cBase + 1]  = 0.10; this.colors[cBase + 2]  = 0.11; this.colors[cBase + 3]  = w.prevAlpha;
    this.colors[cBase + 4]  = 0.10; this.colors[cBase + 5]  = 0.10; this.colors[cBase + 6]  = 0.11; this.colors[cBase + 7]  = w.prevAlpha;
    this.colors[cBase + 8]  = 0.10; this.colors[cBase + 9]  = 0.10; this.colors[cBase + 10] = 0.11; this.colors[cBase + 11] = curAlpha;
    this.colors[cBase + 12] = 0.10; this.colors[cBase + 13] = 0.10; this.colors[cBase + 14] = 0.11; this.colors[cBase + 15] = curAlpha;

    w.uvV = nextUvV;
    w.prevAlpha = curAlpha;
    this._dirty = true;
  }

  recordWheel(wheelIdx, hitPoint, hitNormal, rightDir, skidStrength) {
    const w = this.wheels[wheelIdx];
    const isSkidding = skidStrength > 0.22;

    if (!isSkidding) {
      if (w.hasPrev && w.prevAlpha > 0.04 && hitPoint) {
        this._curPos.copy(hitPoint).addScaledVector(hitNormal, 0.017);
        const dist = this._curPos.distanceTo(w.prevPos);
        if (dist >= 0.14 && dist < 2.2) {
          const halfW = 0.095 * CAR_SCALE;
          this._curLeft.copy(this._curPos).addScaledVector(rightDir, -halfW);
          this._curRight.copy(this._curPos).addScaledVector(rightDir, halfW);
          this._writeSegment(w, this._curLeft, this._curRight, 0.0, dist);
        }
      }
      w.hasPrev = false;
      return;
    }

    this._curPos.copy(hitPoint).addScaledVector(hitNormal, 0.017);
    const halfW = 0.095 * CAR_SCALE;
    this._curLeft.copy(this._curPos).addScaledVector(rightDir, -halfW);
    this._curRight.copy(this._curPos).addScaledVector(rightDir, halfW);
    const targetAlpha = THREE.MathUtils.clamp((skidStrength - 0.15) * 0.85, 0.12, 0.78);

    if (!w.hasPrev) {
      w.hasPrev = true;
      w.prevPos.copy(this._curPos);
      w.prevLeft.copy(this._curLeft);
      w.prevRight.copy(this._curRight);
      w.prevAlpha = 0.05;
      w.uvV = 0;
      return;
    }

    const dist = this._curPos.distanceTo(w.prevPos);
    if (dist > 2.4) {
      // Quebra continuidade em saltos longos ou teleporte/reset
      w.prevPos.copy(this._curPos);
      w.prevLeft.copy(this._curLeft);
      w.prevRight.copy(this._curRight);
      w.prevAlpha = 0.05;
      return;
    }

    if (dist < 0.20) return;

    this._writeSegment(w, this._curLeft, this._curRight, targetAlpha, dist);
    w.prevPos.copy(this._curPos);
    w.prevLeft.copy(this._curLeft);
    w.prevRight.copy(this._curRight);
  }

  commitUpdates() {
    if (!this._dirty) return;
    this._dirty = false;
    this.geometry.setDrawRange(0, this.count * 6);
    this.posAttr.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }
}

// ============================================================================
// 5. SEPARADOR CIRÚRGICO DO CORSA + FARÓIS HALÓGENOS (BRANCO QUENTE), FREIO E RÉ
// ============================================================================
let headlightMat = null;
let brakeLightMat = null;
let thirdBrakeLightMat = null;
let reverseLightMat = null;

const CAMERA_MODE_NAMES = ['PERSEGUIÇÃO', 'CAPÔ (MOTOR)', 'ESCAPAMENTO', 'ÓRBITA 3D'];

// Dispara o espirro da válvula de alívio do turbo (áudio posicional 3D no motor + vapor sutil sob o capô)
const _turboBayPos = new THREE.Vector3();
const _turboPuffVel = new THREE.Vector3();
function triggerTurboBlowOff() {
  if (!state.turboInstalled) return;
  // A válvula de alívio SÓ espirra se o turbo estiver cheio (pressão acumulada >= 0.65)!
  if (state.turboBoost < 0.65) return;

  carAudio.playTurboBlowOff();

  if (smokeSystem && carAudio && carAudio.engineAnchor) {
    const tempBayPos = _turboBayPos;
    carAudio.engineAnchor.getWorldPosition(tempBayPos);
    tempBayPos.y += 0.14 * CAR_SCALE;
    tempBayPos.z -= 0.16 * CAR_SCALE;

    for (let i = 0; i < 4; i++) {
      const puffVel = _turboPuffVel.set(
        (Math.random() - 0.5) * 0.55,
        0.35 + Math.random() * 0.40,
        -0.95 - Math.random() * 0.60
      );
      smokeSystem.spawn(tempBayPos, puffVel, {
        startScale: 0.14,
        endScale: 0.75,
        opacity: 0.46,
        maxAge: 0.50,
        colorHex: 0xf8fafc
      });
    }
  }

  // Ao espirrar, a válvula de alívio despressuriza o sistema de admissão
  state.turboBoost = 0.05;
}

function createCarContactShadow() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Gradiente suave simulando a oclusão ambiental (AO) de contato sob o assoalho
  const grad = ctx.createRadialGradient(128, 128, 25, 128, 128, 122);
  grad.addColorStop(0.00, 'rgba(0, 0, 0, 0.88)');
  grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.62)');
  grad.addColorStop(0.80, 'rgba(0, 0, 0, 0.22)');
  grad.addColorStop(1.00, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = grad;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(16, 26, 224, 204, 38);
    ctx.fill();
  } else {
    ctx.fillRect(16, 26, 224, 204);
  }

  const texture = new THREE.CanvasTexture(canvas);
  const geom = new THREE.PlaneGeometry(1.75 * CAR_SCALE, 3.85 * CAR_SCALE);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, -0.54 * CAR_SCALE, 0.08 * CAR_SCALE);
  return mesh;
}

function splitCorsaModelIntoChassisAndWheels(gltfScene) {
  const chassisGroup = new THREE.Group();
  const wheelVisualGroups = [
    new THREE.Group(), // 0: FL (Dianteira Esquerda)
    new THREE.Group(), // 1: FR (Dianteira Direita)
    new THREE.Group(), // 2: RL (Traseira Esquerda)
    new THREE.Group()  // 3: RR (Traseira Direita)
  ];

  headlightMat = new THREE.MeshStandardMaterial({
    color: 0xfef3c7,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0.0,
    roughness: 0.15,
    metalness: 0.15,
    transparent: true,
    opacity: 0.82
  });

  brakeLightMat = new THREE.MeshStandardMaterial({
    color: 0x881313,
    emissive: new THREE.Color(0xdc2626),
    emissiveIntensity: 0.0,
    roughness: 0.22,
    metalness: 0.1,
    transparent: true,
    opacity: 0.88
  });

  thirdBrakeLightMat = new THREE.MeshStandardMaterial({
    color: 0x7f1d1d,
    emissive: new THREE.Color(0xef4444),
    emissiveIntensity: 0.0,
    roughness: 0.20,
    metalness: 0.1,
    transparent: true,
    opacity: 0.90
  });

  reverseLightMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    emissive: new THREE.Color(0xfef9c3),
    emissiveIntensity: 0.0,
    roughness: 0.18,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85
  });

  gltfScene.updateMatrixWorld(true);

  const meshes = [];
  gltfScene.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });

  function getWheelIndex(rawX, rawZ) {
    const isLeftAfterRotZ = rawX > 0;
    if (rawZ < 0) {
      return isLeftAfterRotZ ? 0 : 1; // FL = 0, FR = 1
    } else {
      return isLeftAfterRotZ ? 2 : 3; // RL = 2, RR = 3
    }
  }

  function isInsideWheelCylinder(rawX, rawY, rawZ) {
    if (Math.abs(rawX) < 58.0) return false;
    const distFront = Math.hypot(rawY - (-28.54), rawZ - (-113.89));
    const distRear = Math.hypot(rawY - (-28.54), rawZ - 129.57);
    return Math.min(distFront, distRear) < 28.65;
  }

  meshes.forEach((mesh) => {
    const matName = (mesh.material?.name || '').toLowerCase();
    const nodeName = (mesh.name || '').toLowerCase();

    let clonedMat;
    if (matName.includes('carpaint')) {
      // Pintura automotiva física com camada de verniz (Clearcoat) para reflexos nítidos e profundos
      clonedMat = new THREE.MeshPhysicalMaterial({
        name: mesh.material.name,
        color: mesh.material.color.clone(),
        map: mesh.material.map || null,
        side: mesh.material.side,
        metalness: 0.24,
        roughness: 0.22,
        clearcoat: 1.0,
        clearcoatRoughness: 0.035,
        ior: 1.5,
        reflectivity: 1.0,
        envMapIntensity: 1.9
      });
      corsaReflectiveMaterials.paint.push(clonedMat);
    } else if (matName.includes('windowglass') || matName.includes('clearglass')) {
      clonedMat = new THREE.MeshPhysicalMaterial({
        name: mesh.material.name,
        color: mesh.material.color.clone(),
        transparent: true,
        opacity: matName.includes('clearglass') ? 0.30 : 0.48,
        roughness: 0.03,
        metalness: 0.12,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        reflectivity: 1.0,
        envMapIntensity: 2.3,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      corsaReflectiveMaterials.glass.push(clonedMat);
    } else {
      clonedMat = mesh.material.clone();
      if (matName.includes('interior')) {
        clonedMat.roughness = 0.85;
        clonedMat.metalness = 0.05;
        clonedMat.envMapIntensity = 0.3;
        clonedMat.side = THREE.DoubleSide;
      } else if (matName.includes('chrome') || matName.includes('rim') || matName.includes('mirror') || matName === 'material') {
        clonedMat.metalness = matName.includes('mirror') ? 0.98 : 0.88;
        clonedMat.roughness = matName.includes('mirror') ? 0.03 : 0.14;
        clonedMat.envMapIntensity = 1.95;
        corsaReflectiveMaterials.chrome.push(clonedMat);
      } else if (matName.includes('tire') || matName === 'black') {
        clonedMat.roughness = 0.84;
        clonedMat.metalness = 0.04;
        clonedMat.envMapIntensity = 0.35;
      } else {
        clonedMat.envMapIntensity = 0.5;
      }
    }

    const isPureWheelMaterial =
      matName === 'tire' ||
      matName === 'rim_second' ||
      matName === 'material' ||
      ['object_58', 'object_59', 'object_60', 'object_61'].includes(nodeName);

    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    const normAttr = geom.attributes.normal;
    const uvAttr = geom.attributes.uv;
    const indexAttr = geom.index;

    const buckets = {
      '-1': [],
      '0': [],
      '1': [],
      '2': [],
      '3': [],
      headlight: [],
      brakelight: [],
      thirdbrakelight: [],
      reverselight: []
    };

    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
      const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

      const x0 = posAttr.getX(i0), y0 = posAttr.getY(i0), z0 = posAttr.getZ(i0);
      const x1 = posAttr.getX(i1), y1 = posAttr.getY(i1), z1 = posAttr.getZ(i1);
      const x2 = posAttr.getX(i2), y2 = posAttr.getY(i2), z2 = posAttr.getZ(i2);

      const cx = (x0 + x1 + x2) / 3;
      const cy = (y0 + y1 + y2) / 3;
      const cz = (z0 + z1 + z2) / 3;

      if (isPureWheelMaterial || isInsideWheelCylinder(cx, cy, cz)) {
        const wIdx = getWheelIndex(cx, cz);
        buckets[wIdx].push(i0, i1, i2);
      } else if (matName === 'redglass') {
        if (Math.abs(cx) < 20 && cz > 110) {
          buckets.thirdbrakelight.push(i0, i1, i2);
        } else {
          buckets.brakelight.push(i0, i1, i2);
        }
      } else if (matName === 'clearglass' && cz < -120) {
        buckets.headlight.push(i0, i1, i2);
      } else if ((nodeName === 'object_43' || nodeName === 'object_41') && matName === 'clearglass' && cz > 140) {
        buckets.reverselight.push(i0, i1, i2);
      } else {
        buckets['-1'].push(i0, i1, i2);
      }
    }

    Object.keys(buckets).forEach((bKey) => {
      const indices = buckets[bKey];
      if (indices.length === 0) return;

      const isWheel = ['0', '1', '2', '3'].includes(bKey);
      const bIdx = isWheel ? parseInt(bKey, 10) : -1;

      const subGeom = new THREE.BufferGeometry();
      const newPos = new Float32Array(indices.length * 3);
      const newNorm = normAttr ? new Float32Array(indices.length * 3) : null;
      const newUv = uvAttr ? new Float32Array(indices.length * 2) : null;

      const centerRaw = isWheel ? WHEEL_HUBS_LOCAL[bIdx].rawCenter : new THREE.Vector3(0, 0, 0);
      const scaleFactor = 0.01 * CAR_SCALE;

      for (let k = 0; k < indices.length; k++) {
        const vi = indices[k];
        const rx = -(posAttr.getX(vi) - centerRaw.x) * scaleFactor;
        const ry = -(posAttr.getY(vi) - centerRaw.y) * scaleFactor;
        const rz =  (posAttr.getZ(vi) - centerRaw.z) * scaleFactor;

        newPos[k * 3] = rx;
        newPos[k * 3 + 1] = ry;
        newPos[k * 3 + 2] = rz;

        if (newNorm) {
          newNorm[k * 3] = -normAttr.getX(vi);
          newNorm[k * 3 + 1] = -normAttr.getY(vi);
          newNorm[k * 3 + 2] =  normAttr.getZ(vi);
        }
        if (newUv) {
          newUv[k * 2] = uvAttr.getX(vi);
          newUv[k * 2 + 1] = uvAttr.getY(vi);
        }
      }

      subGeom.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
      if (newNorm) subGeom.setAttribute('normal', new THREE.BufferAttribute(newNorm, 3));
      else subGeom.computeVertexNormals();
      if (newUv) subGeom.setAttribute('uv', new THREE.BufferAttribute(newUv, 2));

      let matToUse = clonedMat;
      if (bKey === 'headlight') matToUse = headlightMat;
      else if (bKey === 'brakelight') matToUse = brakeLightMat;
      else if (bKey === 'thirdbrakelight') matToUse = thirdBrakeLightMat;
      else if (bKey === 'reverselight') matToUse = reverseLightMat;

      const subMesh = new THREE.Mesh(subGeom, matToUse);
      subMesh.castShadow = !['headlight', 'brakelight', 'thirdbrakelight', 'reverselight'].includes(bKey);
      subMesh.receiveShadow = false;

      if (bIdx === -1) {
        chassisGroup.add(subMesh);
      } else {
        wheelVisualGroups[bIdx].add(subMesh);
      }
    });
  });

  const CHASSIS_COM_OFFSET_Y = 0.55 * CAR_SCALE;
  chassisGroup.children.forEach((c) => {
    c.position.y -= CHASSIS_COM_OFFSET_Y;
  });

  // Sombra de contato suave sob o assoalho do Corsa (elimina o efeito de carro flutuando)
  chassisGroup.add(createCarContactShadow());

  return {
    chassisGroup,
    wheelVisualGroups,
    chassisComOffsetY: CHASSIS_COM_OFFSET_Y
  };
}

// ============================================================================
// 6. COLISÃO ESTÁTICA SÓLIDA DO MAPA (ASFALTO 100% CONTÍNUO + OBSTÁCULOS SECTORIZADOS)
// ============================================================================
function getObjectNodePath(obj, stopAt) {
  const parts = [];
  let cur = obj;
  while (cur && cur !== stopAt) {
    if (cur.name) parts.push(cur.name.toLowerCase());
    cur = cur.parent;
  }
  return parts.reverse().join('/');
}

async function buildCityPhysicsFromModel(cityScene, physicsWorld, groundMaterial, wallMaterial, onProgress) {
  cityScene.updateMatrixWorld(true);

  const ignoredSubtreePatterns = ['lod1', 'lod_b', 'challangemode', 'collectablesallzones'];
  const meshes = [];

  cityScene.traverse((child) => {
    child.matrixAutoUpdate = false;
    const nodeName = (child.name || '').toLowerCase();
    if (ignoredSubtreePatterns.some((pat) => nodeName.includes(pat))) {
      child.visible = false;
      return;
    }

    if (child.isMesh && child.geometry && child.geometry.attributes.position) {
      const path = getObjectNodePath(child, cityScene);
      if (ignoredSubtreePatterns.some((pat) => path.includes(pat))) {
        child.visible = false;
        return;
      }

      const isNetworkBoundWall = path.includes('wall_11') || path.includes('networkbound');
      if (isNetworkBoundWall) {
        child.visible = false;
      } else {
        child.castShadow = false;
        child.receiveShadow = false;
      }

      // Normaliza materiais da cidade sem forçar DoubleSide (a malha combinada corrige a rotação de faces espelhadas)
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (!m) return;
        if (!cityTrackedMaterials.has(m)) {
          cityTrackedMaterials.add(m);
          m.envMapIntensity = 0.22;
        }
      });

      meshes.push({ mesh: child, path, isNetworkBoundWall });
    }
  });

  const ROAD_SECTOR_SIZE = 75.0;
  const roadSectorMap = new Map();
  const minimapRoadSectorMap = new Map();

  const wallSegments = [];
  const dedupWallSet = new Set();

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const meshAABB = new THREE.Box3();

  const PLAY_MIN_X = -920.0;
  const PLAY_MAX_X = 920.0;
  const PLAY_MIN_Z = -720.0;
  const PLAY_MAX_Z = 720.0;
  const PLAY_MIN_Y = 14.0;
  const PLAY_MAX_Y = 105.0;

  function appendTriToSector(sectorMap, sx, sz, surfaceType, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const sKey = surfaceType ? `${sx}_${sz}_${surfaceType}` : `${sx}_${sz}`;
    let sRoad = sectorMap.get(sKey);
    if (!sRoad) {
      sRoad = { verts: [], indices: [], offset: 0, surfaceType: surfaceType || 'asphalt' };
      sectorMap.set(sKey, sRoad);
    }
    sRoad.verts.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    sRoad.indices.push(sRoad.offset, sRoad.offset + 1, sRoad.offset + 2);
    sRoad.offset += 3;
  }

  function pushWallSegment(ax, az, bx, bz, midY, wallHeight) {
    const dx = bx - ax;
    const dz = bz - az;
    const totalLen = Math.hypot(dx, dz);
    if (totalLen < 0.65) return;

    const angleY = Math.atan2(dx, dz);
    const angBucket = Math.round(((angleY % Math.PI) + Math.PI) % Math.PI / (Math.PI / 10));
    const subCount = Math.max(1, Math.ceil(totalLen / 16.0));
    const segLen = (totalLen / subCount) + 0.35;

    for (let s = 0; s < subCount; s++) {
      const t = (s + 0.5) / subCount;
      const cx = ax + dx * t;
      const cz = az + dz * t;
      const gx = Math.round(cx * 0.35);
      const gy = Math.round(midY * 0.16);
      const gz = Math.round(cz * 0.35);
      const wallKey = `${gx}_${gy}_${gz}_${angBucket}`;

      if (!dedupWallSet.has(wallKey)) {
        dedupWallSet.add(wallKey);
        wallSegments.push({
          x: cx,
          y: midY,
          z: cz,
          len: Math.max(1.0, segLen),
          height: wallHeight,
          angleY
        });
      }
    }
  }

  const totalMeshes = meshes.length;

  for (let m = 0; m < totalMeshes; m++) {
    const { mesh, path, isNetworkBoundWall } = meshes[m];
    const geom = mesh.geometry;
    const pos = geom.attributes.position;

    if (!geom.boundingBox) geom.computeBoundingBox();
    meshAABB.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);

    if (
      meshAABB.max.x < PLAY_MIN_X || meshAABB.min.x > PLAY_MAX_X ||
      meshAABB.max.z < PLAY_MIN_Z || meshAABB.min.z > PLAY_MAX_Z ||
      meshAABB.max.y < PLAY_MIN_Y || meshAABB.min.y > 260.0
    ) {
      continue;
    }

    if (path.includes('water_') || path.includes('/water') || path.includes('ocean')) {
      continue;
    }

    const isStreetOrBridge =
      path.includes('road_') ||
      path.includes('streets') ||
      path.includes('pavement') ||
      path.includes('lombard') ||
      path.includes('ramp') ||
      path.includes('bridge_01_connection') ||
      path.includes('bridge_segment_01_03') ||
      path.includes('sidewalk') ||
      path.includes('tunnel');

    const isGroundSurface =
      !isNetworkBoundWall &&
      (isStreetOrBridge || path.includes('terrain_01') || path.includes('concrete_01'));

    let meshSurfaceType = 'asphalt';
    if (path.includes('bridge_01_connection') || path.includes('bridge_segment_01_03')) {
      meshSurfaceType = 'bridge';
    } else if (path.includes('terrain_01')) {
      meshSurfaceType = 'dirt';
    } else if (path.includes('sidewalk') || path.includes('lombard') || path.includes('concrete_01')) {
      meshSurfaceType = 'sidewalk';
    }

    const isSmallFoliageProp =
      !isGroundSurface &&
      (path.includes('/tree') || path.includes('bush') || path.includes('pot_'));

    if (isGroundSurface && meshAABB.min.y < 105.0 && meshAABB.max.y > 25.0) {
      mesh.receiveShadow = true;
    }

    const idxAttr = geom.index;
    const triCount = idxAttr ? idxAttr.count / 3 : pos.count / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
      const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

      v0.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      v1.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      v2.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);

      const minY = Math.min(v0.y, v1.y, v2.y);
      const maxY = Math.max(v0.y, v1.y, v2.y);
      if (minY > PLAY_MAX_Y || maxY < PLAY_MIN_Y) continue;

      const midX = (v0.x + v1.x + v2.x) / 3;
      const midZ = (v0.z + v1.z + v2.z) / 3;
      if (midX < PLAY_MIN_X || midX > PLAY_MAX_X || midZ < PLAY_MIN_Z || midZ > PLAY_MAX_Z) continue;

      edge1.subVectors(v1, v0);
      edge2.subVectors(v2, v0);
      normal.crossVectors(edge1, edge2);
      const doubleArea = normal.length();

      if (doubleArea < 0.0005) continue;
      normal.divideScalar(doubleArea);

      // 1. Asfalto, Calçadas, Ladeiras, Pontes e Terreno de San Francisco (apenas topo normal.y > 0.35)
      if (isGroundSurface && normal.y > 0.35 && maxY <= 102.0) {
        const sx = Math.floor(midX / ROAD_SECTOR_SIZE);
        const sz = Math.floor(midZ / ROAD_SECTOR_SIZE);
        appendTriToSector(roadSectorMap, sx, sz, meshSurfaceType, v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);

        if (isStreetOrBridge) {
          appendTriToSector(minimapRoadSectorMap, sx, sz, null, v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
        }
      }
      // 2. Paredes, Prédios, Guardrails da Ponte, Túneis e Limites de San Francisco
      else if (!isSmallFoliageProp && Math.abs(normal.y) < 0.48 && (maxY - minY) > 0.40 && minY <= 89.5 && maxY >= 36.0) {
        let maxDist2D = 0;
        let bestA = v0;
        let bestB = v1;

        const d01 = Math.hypot(v1.x - v0.x, v1.z - v0.z);
        if (d01 > maxDist2D) { maxDist2D = d01; bestA = v0; bestB = v1; }
        const d12 = Math.hypot(v2.x - v1.x, v2.z - v1.z);
        if (d12 > maxDist2D) { maxDist2D = d12; bestA = v1; bestB = v2; }
        const d20 = Math.hypot(v0.x - v2.x, v0.z - v2.z);
        if (d20 > maxDist2D) { maxDist2D = d20; bestA = v2; bestB = v0; }

        if (maxDist2D >= 0.65) {
          const midY = (minY + maxY) * 0.5;
          const wallHeight = Math.max(1.2, maxY - minY);
          pushWallSegment(bestA.x, bestA.z, bestB.x, bestB.z, midY, wallHeight);
        }
      }
    }

    if (m % 80 === 0) {
      if (onProgress) {
        const pct = Math.round((m / totalMeshes) * 85);
        onProgress(pct);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (onProgress) {
    onProgress(90, 'Construindo malha física do asfalto e pontes...');
  }
  await new Promise((r) => setTimeout(r, 0));

  let totalRoadTris = 0;
  roadSectorMap.forEach((sRoad) => {
    if (sRoad.verts.length === 0) return;
    totalRoadTris += sRoad.indices.length / 3;
    const roadTrimesh = new CANNON.Trimesh(sRoad.verts, sRoad.indices);
    const roadBody = new CANNON.Body({
      mass: 0,
      material: groundMaterial,
      shape: roadTrimesh
    });
    roadBody.surfaceType = sRoad.surfaceType || 'asphalt';
    roadBody.collisionFilterGroup = COLLISION_GROUND;
    roadBody.collisionFilterMask = COLLISION_CHASSIS | COLLISION_WALLS;
    physicsWorld.addBody(roadBody);
  });

  if (onProgress) {
    onProgress(95, 'Solidificando prédios, guardrails e limites...');
  }
  await new Promise((r) => setTimeout(r, 0));

  const SECTOR_SIZE = 85.0;
  const sectorGroups = new Map();

  for (let i = 0; i < wallSegments.length; i++) {
    const seg = wallSegments[i];
    const sx = Math.floor(seg.x / SECTOR_SIZE);
    const sz = Math.floor(seg.z / SECTOR_SIZE);
    const key = `${sx}_${sz}`;

    let group = sectorGroups.get(key);
    if (!group) {
      group = [];
      sectorGroups.set(key, group);
    }
    group.push(seg);
  }

  const qWall = new CANNON.Quaternion();
  const MAX_SHAPES_PER_BODY = 140;

  sectorGroups.forEach((segs) => {
    for (let i = 0; i < segs.length; i += MAX_SHAPES_PER_BODY) {
      const chunk = segs.slice(i, i + MAX_SHAPES_PER_BODY);
      const sectorBody = new CANNON.Body({
        mass: 0,
        material: wallMaterial
      });
      sectorBody.collisionFilterGroup = COLLISION_WALLS;
      sectorBody.collisionFilterMask = COLLISION_CHASSIS;

      chunk.forEach((seg) => {
        const box = new CANNON.Box(new CANNON.Vec3(0.38, seg.height * 0.5, seg.len * 0.5));
        qWall.setFromEuler(0, seg.angleY, 0);
        sectorBody.addShape(box, new CANNON.Vec3(seg.x, seg.y, seg.z), qWall);
      });

      physicsWorld.addBody(sectorBody);
    }
  });

  const safetyPlane = new CANNON.Body({
    mass: 0,
    material: groundMaterial,
    shape: new CANNON.Plane()
  });
  safetyPlane.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  safetyPlane.position.set(0, 2.0, 0);
  safetyPlane.collisionFilterGroup = COLLISION_GROUND | COLLISION_WALLS;
  safetyPlane.collisionFilterMask = COLLISION_CHASSIS | COLLISION_GROUND;
  physicsWorld.addBody(safetyPlane);

  console.log(
    `San Francisco carregado: ${totalRoadTris} triângulos de via em ${roadSectorMap.size} setores e ${wallSegments.length} barreiras sólidas em ${sectorGroups.size} setores!`
  );

  if (minimapRenderer) {
    minimapRenderer.buildRoadPaths(minimapRoadSectorMap.size > 0 ? minimapRoadSectorMap : roadSectorMap, wallSegments);
  }
}

// Agrupa malhas estáticas por material e setor espacial de 320m x 320m (reduz ~1.400 draw calls para ~150)
function buildBatchedCityRenderGroup(cityScene) {
  cityScene.updateMatrixWorld(true);
  const BATCH_CHUNK = 320.0;
  const buckets = new Map();
  const worldBox = new THREE.Box3();
  const center = new THREE.Vector3();

  cityScene.traverse((child) => {
    if (!child.isMesh || !child.visible || !child.geometry || !child.geometry.attributes.position) return;
    if (Array.isArray(child.material) || !child.material) return;

    const geom = child.geometry;
    if (!geom.boundingBox) geom.computeBoundingBox();
    worldBox.copy(geom.boundingBox).applyMatrix4(child.matrixWorld);
    worldBox.getCenter(center);

    const cx = Math.floor(center.x / BATCH_CHUNK);
    const cz = Math.floor(center.z / BATCH_CHUNK);
    const recvShadow = child.receiveShadow ? 1 : 0;
    const key = `${cx}_${cz}_${child.material.uuid}_${recvShadow}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material: child.material, receiveShadow: Boolean(recvShadow), items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(child);
    child.visible = false;
  });

  const mergedGroup = new THREE.Group();
  const normalMat = new THREE.Matrix3();
  const vPos = new THREE.Vector3();
  const vNorm = new THREE.Vector3();

  buckets.forEach((bucket) => {
    let totalVerts = 0;
    let totalIndices = 0;
    let hasUv = true;
    let hasUv1 = true;

    for (let k = 0; k < bucket.items.length; k++) {
      const g = bucket.items[k].geometry;
      const pCount = g.attributes.position.count;
      totalVerts += pCount;
      totalIndices += g.index ? g.index.count : pCount;
      if (!g.attributes.uv) hasUv = false;
      if (!g.attributes.uv1) hasUv1 = false;
    }

    if (totalVerts === 0 || totalIndices === 0) return;

    const posArr = new Float32Array(totalVerts * 3);
    const normArr = new Float32Array(totalVerts * 3);
    const uvArr = hasUv ? new Float32Array(totalVerts * 2) : null;
    const uv1Arr = hasUv1 ? new Float32Array(totalVerts * 2) : null;
    const idxArr = totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

    let vCursor = 0;
    let iCursor = 0;

    for (let k = 0; k < bucket.items.length; k++) {
      const mesh = bucket.items[k];
      const geom = mesh.geometry;
      const pos = geom.attributes.position;
      const norm = geom.attributes.normal;
      const uv = geom.attributes.uv;
      const uv1 = geom.attributes.uv1;
      const idx = geom.index;
      const wm = mesh.matrixWorld;
      const isMirrored = wm.determinant() < 0;
      normalMat.getNormalMatrix(wm);

      for (let v = 0; v < pos.count; v++) {
        vPos.fromBufferAttribute(pos, v).applyMatrix4(wm);
        const o3 = (vCursor + v) * 3;
        posArr[o3] = vPos.x;
        posArr[o3 + 1] = vPos.y;
        posArr[o3 + 2] = vPos.z;

        if (norm) {
          vNorm.fromBufferAttribute(norm, v).applyMatrix3(normalMat).normalize();
          normArr[o3] = vNorm.x;
          normArr[o3 + 1] = vNorm.y;
          normArr[o3 + 2] = vNorm.z;
        } else {
          normArr[o3 + 1] = 1;
        }

        if (uvArr && uv) {
          const o2 = (vCursor + v) * 2;
          uvArr[o2] = uv.getX(v);
          uvArr[o2 + 1] = uv.getY(v);
        }
        if (uv1Arr && uv1) {
          const o2 = (vCursor + v) * 2;
          uv1Arr[o2] = uv1.getX(v);
          uv1Arr[o2 + 1] = uv1.getY(v);
        }
      }

      const triCount = (idx ? idx.count : pos.count) / 3;
      for (let t = 0; t < triCount; t++) {
        const a = vCursor + (idx ? idx.getX(t * 3) : t * 3);
        const b = vCursor + (idx ? idx.getX(t * 3 + 1) : t * 3 + 1);
        const c = vCursor + (idx ? idx.getX(t * 3 + 2) : t * 3 + 2);
        if (isMirrored) {
          idxArr[iCursor++] = a;
          idxArr[iCursor++] = c;
          idxArr[iCursor++] = b;
        } else {
          idxArr[iCursor++] = a;
          idxArr[iCursor++] = b;
          idxArr[iCursor++] = c;
        }
      }

      vCursor += pos.count;
    }

    const mergedGeom = new THREE.BufferGeometry();
    mergedGeom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    mergedGeom.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
    if (uvArr) mergedGeom.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    if (uv1Arr) mergedGeom.setAttribute('uv1', new THREE.BufferAttribute(uv1Arr, 2));
    mergedGeom.setIndex(new THREE.BufferAttribute(idxArr, 1));
    mergedGeom.computeBoundingSphere();

    const batchMesh = new THREE.Mesh(mergedGeom, bucket.material);
    batchMesh.castShadow = false;
    batchMesh.receiveShadow = bucket.receiveShadow;
    batchMesh.matrixAutoUpdate = false;
    mergedGroup.add(batchMesh);
  });

  console.log(`Otimização WebGL: ${buckets.size} lotes combinados ativos para San Francisco.`);
  return mergedGroup;
}

// ============================================================================
// MINIMAPA DE ALTA PERFORMANCE (MAPA ESTÁTICO PRÉ-RENDERIZADO + GPU BLIT)
// ============================================================================
let minimapRenderer = null;

class MinimapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.viewRadius = 90.0;
    this.rotating = true; // Rotaciona com a frente do carro por padrão

    // Cache de elementos DOM e estados para evitar reflow/DOM queries a cada frame
    this.scaleEl = document.getElementById('minimap-scale');
    this.compassEl = document.getElementById('minimap-compass');
    this.titleEl = document.getElementById('minimap-title');
    this.lastScaleText = '';
    this.lastRenderTime = 0;
    this.tempForward = new THREE.Vector3();

    // Offscreen Canvas onde toda a malha viária da cidade é desenhada UMA ÚNICA VEZ
    this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.width = 1024;
    this.staticCanvas.height = 1024;
    this.staticReady = false;
    this.mapMinX = -450;
    this.mapMaxX = 450;
    this.mapMinZ = -450;
    this.mapMaxZ = 450;
    this.mapScale = 1.0;

    // Permite ao jogador clicar no minimapa para alternar entre "Mapa Rotativo" e "Norte Fixo"
    const container = document.getElementById('minimap-container');
    if (container) {
      container.addEventListener('click', () => {
        this.rotating = !this.rotating;
        if (this.titleEl) {
          this.titleEl.textContent = this.rotating ? 'GPS • ROTAÇÃO' : 'GPS • NORTE FIXO';
        }
      });
    }
  }

  buildRoadPaths(roadSectorMap, wallSegments) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    roadSectorMap.forEach((sRoad) => {
      const verts = sRoad.verts;
      for (let i = 0; i < verts.length; i += 3) {
        const x = verts[i];
        const z = verts[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    });

    if (!isFinite(minX)) {
      minX = -400; maxX = 400; minZ = -400; maxZ = 400;
    }

    const pad = 60;
    this.mapMinX = minX - pad;
    this.mapMaxX = maxX + pad;
    this.mapMinZ = minZ - pad;
    this.mapMaxZ = maxZ + pad;

    const spanX = Math.max(1, this.mapMaxX - this.mapMinX);
    const spanZ = Math.max(1, this.mapMaxZ - this.mapMinZ);
    const maxSpan = Math.max(spanX, spanZ);
    this.mapScale = this.staticCanvas.width / maxSpan;

    const sCtx = this.staticCanvas.getContext('2d');
    sCtx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);

    sCtx.save();
    sCtx.scale(this.mapScale, this.mapScale);
    sCtx.translate(-this.mapMinX, -this.mapMinZ);

    // 1. Camada de borda externa das pistas (contorno ciano suave pré-renderizado sem custo por frame)
    sCtx.fillStyle = 'rgba(56, 189, 248, 0.35)';
    sCtx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    sCtx.lineWidth = 2.2;
    sCtx.lineJoin = 'round';
    roadSectorMap.forEach((sRoad) => {
      const verts = sRoad.verts;
      const triCount = verts.length / 9;
      sCtx.beginPath();
      for (let t = 0; t < triCount; t++) {
        const o = t * 9;
        sCtx.moveTo(verts[o], verts[o + 2]);
        sCtx.lineTo(verts[o + 3], verts[o + 5]);
        sCtx.lineTo(verts[o + 6], verts[o + 8]);
        sCtx.closePath();
      }
      sCtx.stroke();
    });

    // 2. Preenchimento sólido do leito asfaltado (cobre as arestas internas dos triângulos)
    sCtx.fillStyle = '#1e293b';
    roadSectorMap.forEach((sRoad) => {
      const verts = sRoad.verts;
      const triCount = verts.length / 9;
      sCtx.beginPath();
      for (let t = 0; t < triCount; t++) {
        const o = t * 9;
        sCtx.moveTo(verts[o], verts[o + 2]);
        sCtx.lineTo(verts[o + 3], verts[o + 5]);
        sCtx.lineTo(verts[o + 6], verts[o + 8]);
        sCtx.closePath();
      }
      sCtx.fill();
    });

    // 3. Muretas e guardrails pré-renderizados
    if (wallSegments && wallSegments.length > 0) {
      sCtx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      sCtx.lineWidth = 1.2;
      sCtx.beginPath();
      for (let i = 0; i < wallSegments.length; i++) {
        const seg = wallSegments[i];
        const cos = Math.cos(seg.angleY);
        const sin = Math.sin(seg.angleY);
        const hx = sin * (seg.len * 0.5);
        const hz = cos * (seg.len * 0.5);
        sCtx.moveTo(seg.x - hx, seg.z - hz);
        sCtx.lineTo(seg.x + hx, seg.z + hz);
      }
      sCtx.stroke();
    }

    sCtx.restore();
    this.staticReady = true;
  }

  render(carPos, carQuat, speedKmh) {
    if (!this.canvas || !this.ctx || !this.staticReady) return;

    // Atualiza o minimapa a ~30 FPS para liberar 100% da GPU para a cena 3D
    const now = performance.now();
    if (now - this.lastRenderTime < 30) return;
    this.lastRenderTime = now;

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;

    // Fundo azul escuro estilo radar/GPS
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, w, h);

    // Direção frontal do carro (no jogo, frente é -Z)
    this.tempForward.set(0, 0, -1).applyQuaternion(carQuat);
    const carHeading = Math.atan2(-this.tempForward.x, -this.tempForward.z);
    const mapRotation = this.rotating ? carHeading : 0;

    // Zoom dinâmico proporcional à velocidade (80m a 125m)
    const targetRadius = 80.0 + Math.min(speedKmh / 160, 1.0) * 45.0;
    this.viewRadius += (targetRadius - this.viewRadius) * 0.12;
    const scale = (w * 0.45) / this.viewRadius;

    // Atualiza escala textual e bússola apenas quando mudam
    if (this.scaleEl) {
      const newScaleTxt = `${Math.round(this.viewRadius)}m`;
      if (newScaleTxt !== this.lastScaleText) {
        this.lastScaleText = newScaleTxt;
        this.scaleEl.textContent = newScaleTxt;
      }
    }
    if (this.compassEl) {
      const compassAngle = this.rotating ? -carHeading : 0;
      this.compassEl.style.transform = `rotate(${compassAngle.toFixed(3)}rad)`;
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(mapRotation);
    ctx.scale(scale, scale);
    ctx.translate(-carPos.x, -carPos.z);

    // Desenha todo o mapa viário com UMA ÚNICA chamada drawImage acelerada por hardware!
    const mapWorldW = this.staticCanvas.width / this.mapScale;
    const mapWorldH = this.staticCanvas.height / this.mapScale;
    ctx.drawImage(this.staticCanvas, this.mapMinX, this.mapMinZ, mapWorldW, mapWorldH);

    // Marcadores das Avenidas / Spawns
    const marginSq = (this.viewRadius * 1.35) ** 2;
    for (let idx = 0; idx < SPAWN_POINTS.length; idx++) {
      const sp = SPAWN_POINTS[idx];
      const dx = sp.pos.x - carPos.x;
      const dz = sp.pos.z - carPos.z;
      if (dx * dx + dz * dz < marginSq) {
        ctx.save();
        ctx.translate(sp.pos.x, sp.pos.z);
        ctx.rotate(-mapRotation);
        ctx.fillStyle = idx === state.spawnIdx ? '#38bdf8' : '#f59e0b';
        ctx.beginPath();
        ctx.arc(0, 0, 4.2 / scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.restore();

    // Anéis de alcance do radar concêntricos
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 35.0 * scale, 0, Math.PI * 2);
    ctx.arc(cx, cy, 70.0 * scale, 0, Math.PI * 2);
    ctx.stroke();

    // Cone de visão/farol dianteiro
    const beamAngle = this.rotating ? -Math.PI * 0.5 : Math.atan2(-this.tempForward.z, this.tempForward.x) - Math.PI;
    const fovWidth = Math.PI * 0.30;
    const beamRadius = Math.min(w * 0.36, 48.0 * scale);
    ctx.fillStyle = state.headlightsOn ? 'rgba(254, 243, 199, 0.22)' : 'rgba(56, 189, 248, 0.10)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, beamRadius, beamAngle - fovWidth * 0.5, beamAngle + fovWidth * 0.5);
    ctx.closePath();
    ctx.fill();

    // Ícone do Carro (Seta esportiva triangular no centro)
    ctx.save();
    ctx.translate(cx, cy);
    if (!this.rotating) {
      const carAngle = Math.atan2(this.tempForward.x, -this.tempForward.z);
      ctx.rotate(carAngle);
    }

    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9.5);
    ctx.lineTo(5.5, 6.5);
    ctx.lineTo(0, 3.8);
    ctx.lineTo(-5.5, 6.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ============================================================================
// 7. INICIALIZAÇÃO DO CENÁRIO 3D, LUZES DO CARRO, FÍSICA E LOOP PRINCIPAL
// ============================================================================
const container = document.getElementById('canvas-container');
const isLikelyMobileDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (window.innerWidth <= 820);
const renderer = new THREE.WebGLRenderer({
  antialias: !isLikelyMobileDevice,
  powerPreference: 'high-performance'
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b8de);
scene.fog = new THREE.FogExp2(0x87b8de, 0.0018);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.25, 900);

const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x334155, 1.0);
scene.add(hemiLight);

// Luz direcional do Sol / Lua com sombras suaves em alta definição (2048x2048) e normalBias anti-acne
const sunLight = new THREE.DirectionalLight(0xfff8e7, 2.2);
sunLight.position.set(60, 95, 45);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
sunLight.shadow.camera.near = 5;
sunLight.shadow.camera.far = 250;
const d = 22;
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
sunLight.shadow.bias = -0.0003;
sunLight.shadow.normalBias = 0.02; // Elimina moiré e acne de sombra na lataria curva do veículo
scene.add(sunLight);
scene.add(sunLight.target);

// ============================================================================
// SISTEMA DINÂMICO DE ILUMINAÇÃO, REFLEXOS PBR, QUALIDADE GRÁFICA E CICLO DIA/NOITE
// ============================================================================
class EnvironmentTimeSystem {
  constructor(scene, renderer, sunLight, hemiLight) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunLight = sunLight;
    this.hemiLight = hemiLight;

    this.mode = 'day'; // 'day', 'sunset', 'night', 'auto'
    this.hour = 12.0;
    this.lastPmremHour = -999;
    this.prevRenderTarget = null;
    this.prevCarCubePmrem = null;
    this.graphicsPreset = GRAPHICS_PRESETS[state.graphicsQuality] || GRAPHICS_PRESETS.high;
    this.currentFogDensity = 0.0011;

    // PMREM Generator para reflexos PBR na lataria, vidros e cromados
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    // 1. Canvas limpo para o fundo do céu (scene.background)
    this.skyBgCanvas = document.createElement('canvas');
    this.skyBgCanvas.width = 1024;
    this.skyBgCanvas.height = 512;
    this.skyBgCtx = this.skyBgCanvas.getContext('2d');
    this.skyBgTexture = new THREE.CanvasTexture(this.skyBgCanvas);
    this.skyBgTexture.mapping = THREE.EquirectangularReflectionMapping;
    this.skyBgTexture.colorSpace = THREE.SRGBColorSpace; // CRÍTICO: evita estouro branco por dupla conversão gamma!

    // 2. Canvas de reflexão detalhado (Nuvens + Horizonte Urbano 360° + Asfalto + Brilho Solar)
    this.envCanvas = document.createElement('canvas');
    this.envCanvas.width = this.graphicsPreset.envResolution[0];
    this.envCanvas.height = this.graphicsPreset.envResolution[1];
    this.envCtx = this.envCanvas.getContext('2d');
    this.envTexture = new THREE.CanvasTexture(this.envCanvas);
    this.envTexture.mapping = THREE.EquirectangularReflectionMapping;
    this.envTexture.colorSpace = THREE.SRGBColorSpace;

    // 3. CubeCamera para reflexos reais da cidade 3D em tempo real no modo ULTRA
    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(128, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      colorSpace: THREE.SRGBColorSpace
    });
    this.cubeCamera = new THREE.CubeCamera(0.8, 500, this.cubeRenderTarget);
    this.cubeFaceIdx = 0;

    // Nuvens procedurais determinísticas para o domo celeste e reflexos no capô
    this.clouds = [];
    for (let i = 0; i < 42; i++) {
      const seed = (i * 9301 + 49297) % 233280;
      const r1 = seed / 233280;
      const r2 = ((seed * 7 + 13) % 233280) / 233280;
      const r3 = ((seed * 17 + 29) % 233280) / 233280;
      this.clouds.push({
        u: r1,
        v: 0.14 + r2 * 0.28,
        rx: 0.03 + r3 * 0.06,
        ry: 0.012 + r2 * 0.022,
        alpha: 0.22 + r3 * 0.28
      });
    }

    // Silhueta urbana 360° exclusiva para o mapa de reflexão da lataria e vidros
    this.skylineBuildings = [];
    let bx = 0;
    let bIdx = 0;
    while (bx < 1.0) {
      const bw = 0.012 + (((bIdx * 37) % 19) / 19) * 0.024;
      const bh = 0.022 + (((bIdx * 53) % 23) / 23) * 0.075;
      this.skylineBuildings.push({ x: bx, w: bw, h: bh, lit: bIdx % 3 === 0 });
      bx += bw * 0.85;
      bIdx++;
    }

    // Grupo de corpos celestes 3D (Sol com corona, Lua brilhante e campo estelar)
    this.celestialGroup = new THREE.Group();
    this.scene.add(this.celestialGroup);

    this.sunSprite = this.createSunSprite();
    this.celestialGroup.add(this.sunSprite);

    this.moonSprite = this.createMoonSprite();
    this.celestialGroup.add(this.moonSprite);

    this.starfield = this.createStarfield();
    this.celestialGroup.add(this.starfield);

    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.activeLightDir = new THREE.Vector3();

    this.applyPreset(this.mode, true);
  }

  createSunSprite() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createRadialGradient(128, 128, 12, 128, 128, 124);
    grad.addColorStop(0.00, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.14, 'rgba(255, 248, 210, 0.92)');
    grad.addColorStop(0.32, 'rgba(255, 198, 85, 0.65)');
    grad.addColorStop(0.65, 'rgba(255, 145, 45, 0.22)');
    grad.addColorStop(1.00, 'rgba(255, 100, 20, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: texture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    });

    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(66, 66, 1);
    return sprite;
  }

  createMoonSprite() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    const halo = ctx.createRadialGradient(128, 128, 28, 128, 128, 124);
    halo.addColorStop(0.0, 'rgba(215, 235, 255, 0.85)');
    halo.addColorStop(0.32, 'rgba(165, 205, 255, 0.45)');
    halo.addColorStop(0.70, 'rgba(120, 160, 255, 0.15)');
    halo.addColorStop(1.0, 'rgba(90, 130, 240, 0.0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, 256, 256);

    const disc = ctx.createRadialGradient(128, 128, 0, 128, 128, 28);
    disc.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    disc.addColorStop(0.75, 'rgba(235, 245, 255, 0.95)');
    disc.addColorStop(1.0, 'rgba(195, 220, 255, 0.85)');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(128, 128, 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(150, 175, 200, 0.35)';
    ctx.beginPath();
    ctx.arc(120, 122, 9, 0, Math.PI * 2);
    ctx.arc(135, 132, 12, 0, Math.PI * 2);
    ctx.arc(122, 138, 7, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: texture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    });

    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(54, 54, 1);
    return sprite;
  }

  createStarfield() {
    const starCount = 800;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    const cWhite = new THREE.Color(0xffffff);
    const cBlue = new THREE.Color(0xc7d2fe);
    const cAmber = new THREE.Color(0xfef3c7);

    for (let i = 0; i < starCount; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(1.0 - v * 0.96);
      const r = 450.0 + Math.random() * 20.0;

      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      const pal = i % 5 === 0 ? cAmber : i % 3 === 0 ? cBlue : cWhite;
      const lum = 0.70 + Math.random() * 0.30;
      colors[i * 3]     = pal.r * lum;
      colors[i * 3 + 1] = pal.g * lum;
      colors[i * 3 + 2] = pal.b * lum;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 2.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      sizeAttenuation: false
    });

    return new THREE.Points(geom, mat);
  }

  calcCelestialVectors(hour) {
    const progress = ((hour - 6.0) / 24.0) * Math.PI * 2.0;
    const elev = Math.sin(progress);
    const cosP = Math.cos(progress);

    const sx = -cosP * 0.85;
    const sy = Math.max(-0.25, elev);
    const sz = 0.40;
    this.sunDir.set(sx, sy, sz).normalize();

    const mx = cosP * 0.85;
    const my = Math.max(-0.25, -elev);
    const mz = -0.40;
    this.moonDir.set(mx, my, mz).normalize();

    const isDaytime = elev >= -0.05;
    if (isDaytime) {
      this.activeLightDir.copy(this.sunDir);
      if (this.activeLightDir.y < 0.08) this.activeLightDir.y = 0.08;
      this.activeLightDir.normalize();
    } else {
      this.activeLightDir.copy(this.moonDir);
      if (this.activeLightDir.y < 0.12) this.activeLightDir.y = 0.12;
      this.activeLightDir.normalize();
    }

    return { elev, isDaytime };
  }

  drawSkyAndClouds(ctx, w, h, palette) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.00, palette.colZenith);
    grad.addColorStop(0.35, palette.colMid);
    grad.addColorStop(0.50, palette.colHorizon);
    grad.addColorStop(0.515, palette.colGround);
    grad.addColorStop(1.00, palette.colGround);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Desenha nuvens procedurais suaves (dão profundidade ao céu e deslizando sobre o capô/teto nos reflexos!)
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      const cx = c.u * w;
      const cy = c.v * h;
      const rx = c.rx * w;
      const ry = c.ry * h;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      const cGrad = ctx.createRadialGradient(0, 0, rx * 0.1, 0, 0, rx);
      cGrad.addColorStop(0.0, `rgba(${palette.cloudRgb}, ${c.alpha})`);
      cGrad.addColorStop(0.55, `rgba(${palette.cloudRgb}, ${c.alpha * 0.45})`);
      cGrad.addColorStop(1.0, `rgba(${palette.cloudRgb}, 0.0)`);
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  renderSkyEquirectangular(hour, elev) {
    let palette;

    if (hour >= 8.5 && hour <= 16.0) {
      // --- DIA (12:00): Céu azul vívido, luz solar natural sem estourar o branco ---
      palette = {
        colZenith: '#0f3c91',
        colMid: '#2563eb',
        colHorizon: '#7dd3fc',
        colGround: '#1b2028',
        cloudRgb: '255, 255, 255',
        buildingCol: '#1e293b',
        fogHex: 0x8ec5ea,
        fogDensity: 0.0011,
        expVal: 0.90,
        sunColorHex: 0xfff5e0,
        sunInt: 1.65,
        hemiSkyHex: 0x7dd3fc,
        hemiGroundHex: 0x27272a,
        hemiInt: 0.42,
        starsAlpha: 0.0,
        isNight: false
      };
    } else if (hour > 16.0 && hour < 19.5) {
      // --- PÔR DO SOL / GOLDEN HOUR (17:45): Âmbar dourado e azul crepuscular, ZERO rosa/roxo ---
      const t = (hour - 16.0) / 3.5;
      palette = {
        colZenith: '#1b3554',
        colMid: '#b85d28',
        colHorizon: '#f59e0b',
        colGround: '#16181e',
        cloudRgb: '253, 186, 116',
        buildingCol: '#171923',
        fogHex: 0xc97b42,
        fogDensity: 0.0014,
        expVal: 0.96,
        sunColorHex: 0xffa94d,
        sunInt: 1.80,
        hemiSkyHex: 0xf59e0b,
        hemiGroundHex: 0x262322,
        hemiInt: 0.38,
        starsAlpha: t * 0.30,
        isNight: false
      };
    } else if (hour >= 19.5 || hour < 5.0) {
      // --- NOITE PROFUNDA COM LUAR (22:30) ---
      palette = {
        colZenith: '#020617',
        colMid: '#091020',
        colHorizon: '#131c31',
        colGround: '#030508',
        cloudRgb: '51, 65, 85',
        buildingCol: '#04070e',
        fogHex: 0x090e1a,
        fogDensity: 0.0022,
        expVal: 1.18,
        sunColorHex: 0x93c5fd,
        sunInt: 0.45,
        hemiSkyHex: 0x1e293b,
        hemiGroundHex: 0x030508,
        hemiInt: 0.30,
        starsAlpha: 0.92,
        isNight: true
      };
    } else {
      // --- AMANHECER (5:00 - 8:30): Dourado suave e azul matinal ---
      palette = {
        colZenith: '#1e3a6e',
        colMid: '#d97736',
        colHorizon: '#fcd34d',
        colGround: '#1b2028',
        cloudRgb: '254, 215, 170',
        buildingCol: '#1c2432',
        fogHex: 0xdba063,
        fogDensity: 0.0014,
        expVal: 0.94,
        sunColorHex: 0xffe4b5,
        sunInt: 1.55,
        hemiSkyHex: 0xfdba74,
        hemiGroundHex: 0x1e242d,
        hemiInt: 0.42,
        starsAlpha: 0.12,
        isNight: false
      };
    }

    // 1) Renderiza Fundo do Céu limpo (scene.background)
    const bgW = this.skyBgCanvas.width;
    const bgH = this.skyBgCanvas.height;
    this.drawSkyAndClouds(this.skyBgCtx, bgW, bgH, palette);
    this.skyBgTexture.needsUpdate = true;

    // 2) Renderiza Mapa de Reflexos de Alto Contraste (scene.environment via PMREM)
    const ew = this.envCanvas.width;
    const eh = this.envCanvas.height;
    const eCtx = this.envCtx;
    this.drawSkyAndClouds(eCtx, ew, eh, palette);

    // Silhueta urbana 360° na linha do horizonte do mapa de reflexão (dá reflexos nítidos nas portas e vidros!)
    eCtx.fillStyle = palette.buildingCol;
    const horizonY = eh * 0.50;
    for (let i = 0; i < this.skylineBuildings.length; i++) {
      const b = this.skylineBuildings[i];
      const bx = b.x * ew;
      const bw = b.w * ew;
      const bh = b.h * eh;
      eCtx.fillRect(bx, horizonY - bh, bw, bh + 3);
      if (palette.isNight && b.lit) {
        eCtx.fillStyle = 'rgba(253, 224, 71, 0.55)';
        eCtx.fillRect(bx + bw * 0.25, horizonY - bh * 0.75, Math.max(1.5, bw * 0.45), Math.max(1.5, bh * 0.18));
        eCtx.fillStyle = palette.buildingCol;
      }
    }

    // Faixas sutis de reflexo do asfalto abaixo do horizonte
    eCtx.fillStyle = palette.isNight ? 'rgba(148, 163, 184, 0.08)' : 'rgba(255, 255, 255, 0.09)';
    eCtx.fillRect(0, horizonY + eh * 0.08, ew, eh * 0.015);
    eCtx.fillRect(0, horizonY + eh * 0.20, ew, eh * 0.02);

    // Brilho especular intenso do Sol ou Lua no mapa de reflexão
    if (elev > -0.10) {
      const u = (Math.atan2(this.sunDir.z, this.sunDir.x) / (Math.PI * 2) + 0.5) * ew;
      const v = (0.5 - Math.asin(Math.max(-0.99, Math.min(0.99, this.sunDir.y))) / Math.PI) * eh;
      const sunGlow = eCtx.createRadialGradient(u, v, 2, u, v, ew * 0.08);
      sunGlow.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
      sunGlow.addColorStop(0.28, hour > 16.0 ? 'rgba(255, 180, 90, 0.85)' : 'rgba(255, 250, 220, 0.85)');
      sunGlow.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
      eCtx.fillStyle = sunGlow;
      eCtx.beginPath();
      eCtx.arc(u, v, ew * 0.08, 0, Math.PI * 2);
      eCtx.fill();
    } else {
      const u = (Math.atan2(this.moonDir.z, this.moonDir.x) / (Math.PI * 2) + 0.5) * ew;
      const v = (0.5 - Math.asin(Math.max(-0.99, Math.min(0.99, this.moonDir.y))) / Math.PI) * eh;
      const moonGlow = eCtx.createRadialGradient(u, v, 2, u, v, ew * 0.05);
      moonGlow.addColorStop(0.0, 'rgba(230, 245, 255, 0.90)');
      moonGlow.addColorStop(0.45, 'rgba(160, 205, 255, 0.40)');
      moonGlow.addColorStop(1.0, 'rgba(160, 205, 255, 0.0)');
      eCtx.fillStyle = moonGlow;
      eCtx.beginPath();
      eCtx.arc(u, v, ew * 0.05, 0, Math.PI * 2);
      eCtx.fill();
    }

    this.envTexture.needsUpdate = true;

    // Atualiza PMREM e IBL conforme qualidade gráfica
    if (this.graphicsPreset.reflections === 'off') {
      this.scene.environment = null;
    } else {
      const renderTarget = this.pmremGenerator.fromEquirectangular(this.envTexture);
      if (this.prevRenderTarget) {
        this.prevRenderTarget.dispose();
      }
      this.prevRenderTarget = renderTarget;
      this.scene.environment = renderTarget.texture;
    }

    this.scene.background = this.skyBgTexture;

    // Atualiza iluminação da cena
    this.sunLight.color.setHex(palette.sunColorHex);
    this.sunLight.intensity = palette.sunInt;
    this.hemiLight.color.setHex(palette.hemiSkyHex);
    this.hemiLight.groundColor.setHex(palette.hemiGroundHex);
    this.hemiLight.intensity = palette.hemiInt;

    // Atualiza atmosfera (Névoa e Exposição)
    this.currentFogDensity = palette.fogDensity;
    if (this.scene.fog) {
      this.scene.fog.color.setHex(palette.fogHex);
      this.scene.fog.density = palette.fogDensity * (this.graphicsPreset.fogMult || 1.0);
    }
    this.renderer.toneMappingExposure = palette.expVal;

    // Atualiza estrelas e corpos celestes
    if (this.starfield && this.starfield.material) {
      this.starfield.material.opacity = palette.starsAlpha;
      this.starfield.visible = palette.starsAlpha > 0.01;
    }

    this.sunSprite.visible = elev > -0.15;
    this.moonSprite.visible = elev < 0.25;

    this.lastPmremHour = hour;
  }

  setGraphicsPreset(preset) {
    this.graphicsPreset = preset;
    if (this.envCanvas.width !== preset.envResolution[0] || this.envCanvas.height !== preset.envResolution[1]) {
      this.envCanvas.width = preset.envResolution[0];
      this.envCanvas.height = preset.envResolution[1];
    }
    const { elev } = this.calcCelestialVectors(this.hour);
    this.renderSkyEquirectangular(this.hour, elev);
  }

  updateRealtimeCubeReflection(carPos) {
    if (!this.graphicsPreset.realtimeCube || !corsaChassisVisual || !carPos) return;

    this.cubeCamera.position.set(carPos.x, carPos.y + 0.45, carPos.z);
    this.cubeCamera.updateMatrixWorld();

    corsaChassisVisual.visible = false;
    corsaWheelVisuals.forEach((wg) => { wg.visible = false; });

    const prevTarget = this.renderer.getRenderTarget();
    const prevXr = this.renderer.xr.enabled;
    const prevShadowAuto = this.renderer.shadowMap.autoUpdate;
    this.renderer.xr.enabled = false;
    this.renderer.shadowMap.autoUpdate = false;

    // Renderiza 1 face por quadro para manter FPS elevado mesmo no ULTRA
    const faceCam = this.cubeCamera.children[this.cubeFaceIdx];
    this.renderer.setRenderTarget(this.cubeRenderTarget, this.cubeFaceIdx);
    this.renderer.clear();
    this.renderer.render(this.scene, faceCam);

    this.renderer.setRenderTarget(prevTarget);
    this.renderer.xr.enabled = prevXr;
    this.renderer.shadowMap.autoUpdate = prevShadowAuto;

    corsaChassisVisual.visible = true;
    corsaWheelVisuals.forEach((wg) => { wg.visible = true; });

    this.cubeFaceIdx = (this.cubeFaceIdx + 1) % 6;

    if (this.cubeFaceIdx === 0) {
      const pmremRT = this.pmremGenerator.fromCubemap(this.cubeRenderTarget.texture);
      if (this.prevCarCubePmrem) {
        this.prevCarCubePmrem.dispose();
      }
      this.prevCarCubePmrem = pmremRT;
      const tex = pmremRT.texture;
      corsaReflectiveMaterials.paint.forEach((m) => { m.envMap = tex; });
      corsaReflectiveMaterials.glass.forEach((m) => { m.envMap = tex; });
      corsaReflectiveMaterials.chrome.forEach((m) => { m.envMap = tex; });
    }
  }

  update(dt, carPos) {
    if (!carPos) return;

    if (this.mode === 'auto') {
      this.hour = (this.hour + dt * 0.15) % 24.0;
      state.timeHour = this.hour;

      if (Math.abs(this.hour - this.lastPmremHour) >= 0.08) {
        const { elev } = this.calcCelestialVectors(this.hour);
        this.renderSkyEquirectangular(this.hour, elev);
      }
    }

    this.celestialGroup.position.copy(carPos);
    this.sunSprite.position.copy(this.sunDir).multiplyScalar(440.0);
    this.moonSprite.position.copy(this.moonDir).multiplyScalar(440.0);

    if (this.starfield && this.starfield.visible) {
      this.starfield.rotation.y += dt * 0.002;
    }

    if (this.graphicsPreset.realtimeCube && state.started) {
      this.updateRealtimeCubeReflection(carPos);
    }
  }

  applyPreset(mode, force = false) {
    this.mode = mode;
    state.timeOfDay = mode;

    if (mode === 'day') {
      this.hour = 12.0;
    } else if (mode === 'sunset') {
      this.hour = 17.75;
    } else if (mode === 'night') {
      this.hour = 22.5;
    }
    state.timeHour = this.hour;

    const { elev } = this.calcCelestialVectors(this.hour);
    this.renderSkyEquirectangular(this.hour, elev);
    this.updateHudDom();
  }

  getLabel() {
    switch (this.mode) {
      case 'day': return '☀️ DIA';
      case 'sunset': return '🌅 PÔR DO SOL';
      case 'night': return '🌙 NOITE';
      case 'auto': return '🔄 CICLO AUTO';
      default: return '☀️ DIA';
    }
  }

  getMobileLabel() {
    switch (this.mode) {
      case 'day': return 'DIA';
      case 'sunset': return 'TARDE';
      case 'night': return 'NOITE';
      case 'auto': return 'AUTO';
      default: return 'DIA';
    }
  }

  getMobileIcon() {
    switch (this.mode) {
      case 'day': return '☀️';
      case 'sunset': return '🌅';
      case 'night': return '🌙';
      case 'auto': return '🔄';
      default: return '☀️';
    }
  }

  getHudClass() {
    return `tod-${this.mode}`;
  }

  updateHudDom() {
    const todLabel = document.getElementById('tod-label');
    const btnTod = document.getElementById('btn-tod');
    const mTodTxt = document.getElementById('m-tod-txt');
    const mBtnTod = document.getElementById('mbtn-tod');
    const menuTodLabel = document.getElementById('menu-tod-label');

    if (todLabel) todLabel.textContent = this.getLabel();
    if (menuTodLabel) menuTodLabel.textContent = this.getLabel();
    if (btnTod) {
      btnTod.classList.remove('tod-day', 'tod-sunset', 'tod-night', 'tod-auto');
      btnTod.classList.add(this.getHudClass());
    }

    if (mTodTxt) mTodTxt.textContent = this.getMobileLabel();
    if (mBtnTod) {
      const iconSpan = mBtnTod.querySelector('.m-icon');
      if (iconSpan) iconSpan.textContent = this.getMobileIcon();
    }
  }
}

const envTimeSystem = new EnvironmentTimeSystem(scene, renderer, sunLight, hemiLight);

function cycleTimeOfDay() {
  if (!envTimeSystem) return;
  const modes = ['day', 'sunset', 'night', 'auto'];
  const curIdx = modes.indexOf(envTimeSystem.mode);
  const nextMode = modes[(curIdx + 1) % modes.length];
  envTimeSystem.applyPreset(nextMode);

  // Se ativou o modo noturno e os faróis estavam apagados, acende-os automaticamente
  if (nextMode === 'night' && !state.headlightsOn) {
    toggleHeadlights();
  }
}

function applyGraphicsQuality(qualityKey) {
  const preset = GRAPHICS_PRESETS[qualityKey] || GRAPHICS_PRESETS.high;
  state.graphicsQuality = preset.key;

  try {
    localStorage.setItem('corsa3d_graphics', preset.key);
  } catch (e) {}

  // 1. Resolução e Pixel Ratio
  renderer.setPixelRatio(preset.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  // 2. Sombras Dinâmicas
  renderer.shadowMap.enabled = preset.shadows;
  renderer.shadowMap.type = preset.shadowType;
  sunLight.castShadow = preset.shadows;

  if (sunLight.shadow.mapSize.width !== preset.shadowSize ||
      sunLight.shadow.camera.right !== preset.shadowDist) {
    sunLight.shadow.mapSize.set(preset.shadowSize, preset.shadowSize);
    sunLight.shadow.camera.left = -preset.shadowDist;
    sunLight.shadow.camera.right = preset.shadowDist;
    sunLight.shadow.camera.top = preset.shadowDist;
    sunLight.shadow.camera.bottom = -preset.shadowDist;
    sunLight.shadow.camera.updateProjectionMatrix();
    if (sunLight.shadow.map) {
      sunLight.shadow.map.dispose();
      sunLight.shadow.map = null;
    }
  }

  // 3. Distância de renderização
  camera.far = preset.cameraFar;
  camera.updateProjectionMatrix();

  // 4. Partículas de fumaça e marcas de pneu no asfalto
  smokeSystem.setActiveLimit(preset.maxSmokeParticles);
  skidMarkSystem.setActiveLimit(preset.maxSkidSegments);

  // 5. Materiais do Corsa (Clearcoat & Intensidade de Reflexo)
  const paintEnvInt = preset.reflections === 'off' ? 0.0 : preset.reflections === 'sky' ? 1.15 : preset.key === 'ultra' ? 2.1 : 1.9;
  const glassEnvInt = preset.reflections === 'off' ? 0.0 : preset.reflections === 'sky' ? 1.3 : 2.3;
  const chromeEnvInt = preset.reflections === 'off' ? 0.0 : preset.reflections === 'sky' ? 1.2 : 1.95;

  corsaReflectiveMaterials.paint.forEach((m) => {
    m.clearcoat = preset.clearcoat ? 1.0 : 0.0;
    m.clearcoatRoughness = preset.key === 'ultra' ? 0.02 : 0.035;
    m.envMapIntensity = paintEnvInt;
    if (!preset.realtimeCube) m.envMap = null;
    m.needsUpdate = true;
  });
  corsaReflectiveMaterials.glass.forEach((m) => {
    m.clearcoat = preset.clearcoat ? 1.0 : 0.0;
    m.envMapIntensity = glassEnvInt;
    if (!preset.realtimeCube) m.envMap = null;
    m.needsUpdate = true;
  });
  corsaReflectiveMaterials.chrome.forEach((m) => {
    m.envMapIntensity = chromeEnvInt;
    if (!preset.realtimeCube) m.envMap = null;
    m.needsUpdate = true;
  });

  const cityEnvInt = preset.reflections === 'off' ? 0.0 : 0.22;
  cityTrackedMaterials.forEach((m) => {
    m.envMapIntensity = cityEnvInt;
  });

  // 6. Ambiente & PMREM
  if (envTimeSystem) {
    envTimeSystem.setGraphicsPreset(preset);
  }

  // 7. Atualiza UI e badges
  const summaryGfx = document.getElementById('summary-gfx-name');
  const mGfxTxt = document.getElementById('m-graphics-txt');
  if (summaryGfx) summaryGfx.textContent = preset.label;
  if (mGfxTxt) mGfxTxt.textContent = preset.label;

  document.querySelectorAll('.gfx-preset-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.quality === preset.key);
  });
}

function toggleGraphicsModal(forceOpen) {
  if (typeof forceOpen === 'boolean') {
    if (forceOpen) {
      openGameMenu('panel-options', 'tab-graphics');
    } else {
      closeGameMenu();
    }
    return;
  }
  if (state.menuOpen) {
    closeGameMenu();
  } else {
    openGameMenu('panel-options', 'tab-graphics');
  }
}
// Mundo Físico Cannon-es
const world = new CANNON.World();
world.gravity.set(0, -9.81, 0);
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 12;
world.defaultContactMaterial.friction = 0.3;

const groundMat = new CANNON.Material('ground');
const wheelMat = new CANNON.Material('wheel');
const chassisMat = new CANNON.Material('chassis');

world.addContactMaterial(
  new CANNON.ContactMaterial(groundMat, wheelMat, {
    friction: 0.95,
    restitution: 0.0,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 3
  })
);
world.addContactMaterial(
  new CANNON.ContactMaterial(chassisMat, groundMat, {
    friction: 0.05,
    restitution: 0.0
  })
);
world.addContactMaterial(
  new CANNON.ContactMaterial(chassisMat, chassisMat, {
    friction: 0.2,
    restitution: 0.2
  })
);

const smokeSystem = new SmokeParticleSystem(scene, 360);
const skidMarkSystem = new TireSkidMarkSystem(scene, 1400);
const carAudio = new SpatialCarAudio(camera);

let vehicle = null;
let chassisBody = null;
let corsaChassisVisual = null;
let corsaWheelVisuals = [];

// Luzes funcionais 3D do Corsa (Faróis Halógenos, Freios Direcionais e Luzes de Ré Direcionais)
// Importante: mantemos .visible = false quando apagadas para que o shader PBR da GPU não avalie luzes de intensidade zero!
let headlightSpotL = null;
let headlightSpotR = null;
let brakeSpotL = null;
let brakeSpotR = null;
let reverseSpotL = null;
let reverseSpotR = null;

const wheelSpinAngles = [0, 0, 0, 0];

const progressFill = document.getElementById('progress-bar-fill');
const loadingStatus = document.getElementById('loading-status');
const startBtn = document.getElementById('start-btn');
let maxLoadingProgress = 0;

function updateLoadingProgress(pct) {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  maxLoadingProgress = Math.max(maxLoadingProgress, clamped);
  if (progressFill) progressFill.style.width = `${maxLoadingProgress}%`;
  if (loadingStatus) loadingStatus.textContent = `${maxLoadingProgress}%`;
}

function setupCarLights(chassisGroup) {
  const warmHalogenColor = 0xffe082;

  headlightSpotL = new THREE.SpotLight(warmHalogenColor, 0, 36, Math.PI * 0.23, 0.55, 1.4);
  headlightSpotL.position.set(-0.52 * CAR_SCALE, 0.11 * CAR_SCALE, -1.72 * CAR_SCALE);
  headlightSpotL.target.position.set(-0.48 * CAR_SCALE, -0.34 * CAR_SCALE, -14.0 * CAR_SCALE);
  headlightSpotL.visible = false;
  chassisGroup.add(headlightSpotL, headlightSpotL.target);

  headlightSpotR = new THREE.SpotLight(warmHalogenColor, 0, 36, Math.PI * 0.23, 0.55, 1.4);
  headlightSpotR.position.set(0.52 * CAR_SCALE, 0.11 * CAR_SCALE, -1.72 * CAR_SCALE);
  headlightSpotR.target.position.set(0.48 * CAR_SCALE, -0.34 * CAR_SCALE, -14.0 * CAR_SCALE);
  headlightSpotR.visible = false;
  chassisGroup.add(headlightSpotR, headlightSpotR.target);

  // Luzes de freio como SpotLights direcionais saindo do bloco da lanterna para trás/asfalto (zero reflexo na tampa/placa)
  brakeSpotL = new THREE.SpotLight(0xff1e1e, 0, 4.5, Math.PI * 0.34, 0.85, 1.8);
  brakeSpotL.position.set(-0.64 * CAR_SCALE, 0.215 * CAR_SCALE, 1.78 * CAR_SCALE);
  brakeSpotL.target.position.set(-0.78 * CAR_SCALE, -0.40 * CAR_SCALE, 6.2 * CAR_SCALE);
  brakeSpotL.visible = false;
  chassisGroup.add(brakeSpotL, brakeSpotL.target);

  brakeSpotR = new THREE.SpotLight(0xff1e1e, 0, 4.5, Math.PI * 0.34, 0.85, 1.8);
  brakeSpotR.position.set(0.64 * CAR_SCALE, 0.215 * CAR_SCALE, 1.78 * CAR_SCALE);
  brakeSpotR.target.position.set(0.78 * CAR_SCALE, -0.40 * CAR_SCALE, 6.2 * CAR_SCALE);
  brakeSpotR.visible = false;
  chassisGroup.add(brakeSpotR, brakeSpotR.target);

  // Faróis de ré em SpotLight saindo de cada lanterna traseira e projetando cone para trás/chão sem iluminar a placa
  reverseSpotL = new THREE.SpotLight(0xfff6d6, 0, 12.0, Math.PI * 0.26, 0.65, 1.6);
  reverseSpotL.position.set(-0.62 * CAR_SCALE, 0.20 * CAR_SCALE, 1.77 * CAR_SCALE);
  reverseSpotL.target.position.set(-0.75 * CAR_SCALE, -0.45 * CAR_SCALE, 7.5 * CAR_SCALE);
  reverseSpotL.visible = false;
  chassisGroup.add(reverseSpotL, reverseSpotL.target);

  reverseSpotR = new THREE.SpotLight(0xfff6d6, 0, 12.0, Math.PI * 0.26, 0.65, 1.6);
  reverseSpotR.position.set(0.62 * CAR_SCALE, 0.20 * CAR_SCALE, 1.77 * CAR_SCALE);
  reverseSpotR.target.position.set(0.75 * CAR_SCALE, -0.45 * CAR_SCALE, 7.5 * CAR_SCALE);
  reverseSpotR.visible = false;
  chassisGroup.add(reverseSpotR, reverseSpotR.target);
}

async function initSimulation() {
  try {
    const gltfLoader = new GLTFLoader();

    const minimapCanvas = document.getElementById('minimap-canvas');
    if (minimapCanvas) {
      minimapRenderer = new MinimapRenderer(minimapCanvas);
    }

    maxLoadingProgress = 0;
    updateLoadingProgress(0);
    const corsaGltf = await new Promise((res, rej) => {
      gltfLoader.load(
        './opel_corsa_b_3door_1998.glb',
        res,
        (xhr) => {
          if (xhr.total) {
            updateLoadingProgress(Math.min(1, xhr.loaded / xhr.total) * 35);
          }
        },
        rej
      );
    });

    updateLoadingProgress(35);
    const splitResult = splitCorsaModelIntoChassisAndWheels(corsaGltf.scene);
    corsaChassisVisual = splitResult.chassisGroup;
    corsaWheelVisuals = splitResult.wheelVisualGroups;

    setupCarLights(corsaChassisVisual);

    scene.add(corsaChassisVisual);
    corsaWheelVisuals.forEach((wg) => scene.add(wg));

    updateLoadingProgress(38);
    const cityGltf = await new Promise((res, rej) => {
      gltfLoader.load(
        './San Francisco.glb',
        res,
        (xhr) => {
          if (xhr.total) {
            updateLoadingProgress(38 + Math.min(1, xhr.loaded / xhr.total) * 32);
          }
        },
        rej
      );
    });

    const cityRoot = cityGltf.scene;
    cityRoot.scale.set(CITY_SCALE, CITY_SCALE, CITY_SCALE);
    scene.add(cityRoot);

    updateLoadingProgress(70);
    await buildCityPhysicsFromModel(cityRoot, world, groundMat, chassisMat, (pct) => {
      updateLoadingProgress(70 + pct * 0.15);
    });
    scene.add(buildBatchedCityRenderGroup(cityRoot));

    updateLoadingProgress(85);
    await carAudio.loadAll((p) => {
      updateLoadingProgress(85 + p * 15);
    });
    carAudio.setupNodes(corsaChassisVisual);

    setupCorsaPhysics(splitResult.chassisComOffsetY);
    applyGraphicsQuality(state.graphicsQuality);

    state.loaded = true;
    updateLoadingProgress(100);
    const progressSection = document.getElementById('progress-section');
    if (progressSection) progressSection.classList.add('hud-hidden');
    startBtn.disabled = false;
  } catch (err) {
    console.error('Erro ao inicializar simulação:', err);
    loadingStatus.textContent = 'Erro ao carregar arquivos: ' + err.message;
  }
}

const tempCannonForce = new CANNON.Vec3();
const tempCannonPoint = new CANNON.Vec3();
const tempCannonZero = new CANNON.Vec3();
let chassisPreStepRegistered = false;

function applyAntiRollPair(wheelL, wheelR, stiffness) {
  if (!wheelL || !wheelR || !wheelL.isInContact || !wheelR.isInContact) return;
  const compL = wheelL.suspensionRestLength - wheelL.suspensionLength;
  const compR = wheelR.suspensionRestLength - wheelR.suspensionLength;
  const relVelDiff = (wheelL.suspensionRelativeVelocity || 0) - (wheelR.suspensionRelativeVelocity || 0);
  const rawForce = (compL - compR) * stiffness - relVelDiff * (stiffness * 0.032);
  const clampedForce = THREE.MathUtils.clamp(rawForce, -3400, 3400);
  if (Math.abs(clampedForce) < 2.0) return;

  // Empurra lado mais comprimido para cima e traciona lado estendido para baixo (torque de rolagem puro)
  tempCannonForce.set(0, clampedForce, 0);
  tempCannonPoint.set(wheelL.chassisConnectionPointLocal.x, 0, wheelL.chassisConnectionPointLocal.z);
  chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);

  tempCannonForce.set(0, -clampedForce, 0);
  tempCannonPoint.set(wheelR.chassisConnectionPointLocal.x, 0, wheelR.chassisConnectionPointLocal.z);
  chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);
}

const tempSubstepFwd = new CANNON.Vec3();
const tempSubstepRight = new CANNON.Vec3();
const tempSubstepUp = new CANNON.Vec3();
let prevSubstepFwdSpeed = 0;
let smoothPitchCouple = 0;
let smoothRollCouple = 0;

function applyChassisSimulationForces() {
  if (!vehicle || !chassisBody || !state.loaded) return;

  // 1. Barras estabilizadoras dianteira (0-1) e traseira (2-3) atuando em cada substep de física
  applyAntiRollPair(vehicle.wheelInfos[0], vehicle.wheelInfos[1], CORSA_SPECS.frontAntiRollStiffness);
  applyAntiRollPair(vehicle.wheelInfos[2], vehicle.wheelInfos[3], CORSA_SPECS.rearAntiRollStiffness);

  let wheelsOnGround = 0;
  for (let i = 0; i < 4; i++) {
    if (vehicle.wheelInfos[i] && vehicle.wheelInfos[i].isInContact) wheelsOnGround++;
  }
  const groundFactor = wheelsOnGround * 0.25;

  // 2. Arrasto aerodinâmico real (F ~ v²), resistência ao rolamento e transferência dinâmica de peso (mergulho/agachamento/rolagem)
  const vx = chassisBody.velocity.x;
  const vy = chassisBody.velocity.y;
  const vz = chassisBody.velocity.z;
  const speedSq = vx * vx + vy * vy + vz * vz;

  tempSubstepFwd.set(0, 0, -1);
  chassisBody.quaternion.vmult(tempSubstepFwd, tempSubstepFwd);
  tempSubstepRight.set(1, 0, 0);
  chassisBody.quaternion.vmult(tempSubstepRight, tempSubstepRight);
  tempSubstepUp.set(0, 1, 0);
  chassisBody.quaternion.vmult(tempSubstepUp, tempSubstepUp);

  const curFwdSpeed = vx * tempSubstepFwd.x + vy * tempSubstepFwd.y + vz * tempSubstepFwd.z;
  const yawRate =
    chassisBody.angularVelocity.x * tempSubstepUp.x +
    chassisBody.angularVelocity.y * tempSubstepUp.y +
    chassisBody.angularVelocity.z * tempSubstepUp.z;
  const rawLongAccel = THREE.MathUtils.clamp((curFwdSpeed - prevSubstepFwdSpeed) * 60.0, -10.5, 9.0);
  prevSubstepFwdSpeed = curFwdSpeed;

  // Aceleração centrípeta lateral real: a_lat = v_fwd * yaw_rate (em rad/s * m/s)
  const rawLatAccel = THREE.MathUtils.clamp(curFwdSpeed * yawRate, -11.0, 11.0);
  const isHandbrakingSubstep = state.handbrakeInput > 0.5;

  if (wheelsOnGround >= 2) {
    // Binário puro de transferência longitudinal (+ acelera = traseira agacha e frente levanta; - freia = frente mergulha)
    const pitchScale = isHandbrakingSubstep ? 0.40 : 1.0;
    const targetPitchF = THREE.MathUtils.clamp(rawLongAccel * 175.0 * pitchScale, -1850, 1850);
    smoothPitchCouple = THREE.MathUtils.lerp(smoothPitchCouple, targetPitchF, 0.24);
    if (Math.abs(smoothPitchCouple) > 8.0) {
      tempCannonForce.set(0, smoothPitchCouple, 0);
      tempCannonPoint.set(0, 0, -1.14 * CAR_SCALE);
      chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);

      tempCannonForce.set(0, -smoothPitchCouple, 0);
      tempCannonPoint.set(0, 0, 1.30 * CAR_SCALE);
      chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);
    }

    // Binário puro de rolagem lateral conforme esterça/contorna curvas (amortecido no freio de mão para não levantar a traseira interna)
    const rollScale = isHandbrakingSubstep ? 0.42 : 1.0;
    const targetRollF = THREE.MathUtils.clamp(rawLatAccel * 175.0 * rollScale, -1650, 1650);
    smoothRollCouple = THREE.MathUtils.lerp(smoothRollCouple, targetRollF, 0.22);
    if (Math.abs(smoothRollCouple) > 8.0) {
      tempCannonForce.set(0, smoothRollCouple, 0);
      tempCannonPoint.set(-0.75 * CAR_SCALE, 0, 0);
      chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);

      tempCannonForce.set(0, -smoothRollCouple, 0);
      tempCannonPoint.set(0.75 * CAR_SCALE, 0, 0);
      chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);
    }

    // Estabilidade direcional dedicada no eixo Y (guinada) sem endurecer pitch/roll da suspensão:
    // permite entrada rápida no drift com freio de mão e limita diretamente a velocidade de giro para nunca dar pirueta
    const yawDampTorque = -yawRate * 320.0;
    chassisBody.torque.x += tempSubstepUp.x * yawDampTorque;
    chassisBody.torque.y += tempSubstepUp.y * yawDampTorque;
    chassisBody.torque.z += tempSubstepUp.z * yawDampTorque;

    const curLatSpeed = vx * tempSubstepRight.x + vy * tempSubstepRight.y + vz * tempSubstepRight.z;
    const slideAngleRad = Math.atan2(Math.abs(curLatSpeed), Math.max(1.5, Math.abs(curFwdSpeed)));
    const isRotatingIntoSpin = curFwdSpeed > 2.0 && yawRate * curLatSpeed > 0;
    const speedStabilize = THREE.MathUtils.clamp((Math.abs(curFwdSpeed) - 4.2) / 5.5, 0.25, 1.0);

    if (isRotatingIntoSpin && (isHandbrakingSubstep || slideAngleRad > 0.42)) {
      // Ângulo ideal de drift (~20° a ~42°): entrada ágil e contenção progressiva da guinada para drift controlável
      const tAngle = THREE.MathUtils.clamp((slideAngleRad - 0.34) / 0.38, 0.0, 1.0);
      const allowedSpinYaw = THREE.MathUtils.lerp(1.15, isHandbrakingSubstep ? 0.30 : 0.45, tAngle);
      const absYaw = Math.abs(yawRate);
      if (absYaw > allowedSpinYaw) {
        const excessYaw = absYaw - allowedSpinYaw;
        const bleedStrength = (isHandbrakingSubstep ? 0.44 : 0.28) * speedStabilize;
        const yawBleed = Math.min(excessYaw, excessYaw * bleedStrength);
        const signYaw = Math.sign(yawRate);
        chassisBody.angularVelocity.x -= tempSubstepUp.x * signYaw * yawBleed;
        chassisBody.angularVelocity.y -= tempSubstepUp.y * signYaw * yawBleed;
        chassisBody.angularVelocity.z -= tempSubstepUp.z * signYaw * yawBleed;
      }
      // Se passar de ~43° segurando freio de mão em alta, aplica suave contra-torque de recuperação para segurar a atravessada
      if (isHandbrakingSubstep && slideAngleRad > 0.75) {
        const recenterRate = THREE.MathUtils.clamp((slideAngleRad - 0.75) * 0.28, 0.0, 0.16) * speedStabilize;
        const signLat = Math.sign(curLatSpeed);
        chassisBody.angularVelocity.x -= tempSubstepUp.x * signLat * recenterRate;
        chassisBody.angularVelocity.y -= tempSubstepUp.y * signLat * recenterRate;
        chassisBody.angularVelocity.z -= tempSubstepUp.z * signLat * recenterRate;
      }
    }
  } else {
    smoothPitchCouple *= 0.85;
    smoothRollCouple *= 0.85;
  }

  // Batente elástico progressivo de segurança contra capotamento em curvas extremas (~9°+)
  const rollSin = tempSubstepRight.y;
  if (Math.abs(rollSin) > 0.145) {
    const excessRoll = rollSin - Math.sign(rollSin) * 0.145;
    const guardForce = THREE.MathUtils.clamp(excessRoll * 18000.0, -4500, 4500);
    tempCannonForce.set(0, guardForce, 0);
    tempCannonPoint.set(-0.75 * CAR_SCALE, 0, 0);
    chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);

    tempCannonForce.set(0, -guardForce, 0);
    tempCannonPoint.set(0.75 * CAR_SCALE, 0, 0);
    chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);
  }

  if (speedSq > 0.04) {
    const speed = Math.sqrt(speedSq);
    const invSpeed = 1.0 / speed;

    const surfProfile = SURFACE_PROFILES[state.surfaceType] || SURFACE_PROFILES.asphalt;
    const dragMag = 0.92 * speedSq;
    const rollResMag = 132.0 * surfProfile.rollingMul * groundFactor * Math.min(1.0, speed / 0.6);

    const totalResist = dragMag + rollResMag;
    tempCannonForce.set(-vx * invSpeed * totalResist, -vy * invSpeed * (dragMag * 0.35), -vz * invSpeed * totalResist);
    chassisBody.applyForce(tempCannonForce, tempCannonZero);

    if (groundFactor > 0 && speed > 8.0) {
      tempCannonForce.set(0, -0.34 * (vx * vx + vz * vz), 0);
      tempCannonPoint.set(0, 0, -0.1 * CAR_SCALE);
      chassisBody.applyLocalForce(tempCannonForce, tempCannonPoint);
    }
  }
}

function setupCorsaPhysics(comOffsetY) {
  chassisBody = new CANNON.Body({
    mass: CORSA_SPECS.mass,
    material: chassisMat,
    linearDamping: 0.012,
    angularDamping: 0.14 // Mantém pitch/roll vivos enquanto a estabilidade de guinada controla o drift no substep
  });

  // Caixa de colisão elevada (fundo bem acima do asfalto para nunca bater no chão)
  const lowerBox = new CANNON.Box(new CANNON.Vec3(0.70 * CAR_SCALE, 0.16 * CAR_SCALE, 1.68 * CAR_SCALE));
  const cabinBox = new CANNON.Box(new CANNON.Vec3(0.62 * CAR_SCALE, 0.22 * CAR_SCALE, 0.85 * CAR_SCALE));
  chassisBody.addShape(lowerBox, new CANNON.Vec3(0, 0.26 * CAR_SCALE, 0));
  chassisBody.addShape(cabinBox, new CANNON.Vec3(0, 0.52 * CAR_SCALE, 0.15 * CAR_SCALE));

  chassisBody.collisionFilterGroup = COLLISION_CHASSIS;
  chassisBody.collisionFilterMask = COLLISION_WALLS | COLLISION_GROUND;

  vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,   // +X = Direita
    indexUpAxis: 1,      // +Y = Cima
    indexForwardAxis: 2  // Eixo Z longitudinal
  });

  WHEEL_HUBS_LOCAL.forEach((wInfo) => {
    const connX = wInfo.pos.x;
    const wheelHubY = wInfo.pos.y - comOffsetY;
    const connY = wheelHubY + CORSA_SPECS.suspensionRestLength + 0.005 * CAR_SCALE;
    const connZ = wInfo.pos.z;

    vehicle.addWheel({
      radius: CORSA_SPECS.wheelRadius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: wInfo.isFront ? CORSA_SPECS.frontSuspensionStiffness : CORSA_SPECS.rearSuspensionStiffness,
      suspensionRestLength: CORSA_SPECS.suspensionRestLength,
      maxSuspensionTravel: CORSA_SPECS.maxSuspensionTravel,
      maxSuspensionForce: 55000,
      dampingCompression: wInfo.isFront ? CORSA_SPECS.frontDampingCompression : CORSA_SPECS.rearDampingCompression,
      dampingRelaxation: wInfo.isFront ? CORSA_SPECS.frontDampingRelaxation : CORSA_SPECS.rearDampingRelaxation,
      frictionSlip: CORSA_SPECS.frictionSlipNormal,
      rollInfluence: CORSA_SPECS.rollInfluence,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(connX, connY, connZ),
      isFrontWheel: wInfo.isFront,
      useCustomSlidingRotationalSpeed: false
    });
  });

  vehicle.addToWorld(world);
  if (!chassisPreStepRegistered) {
    world.addEventListener('preStep', applyChassisSimulationForces);
    chassisPreStepRegistered = true;
  }
  resetCarToSpawn(0);
}

function resetCarToSpawn(spawnIndex = state.spawnIdx) {
  state.spawnIdx = ((spawnIndex % SPAWN_POINTS.length) + SPAWN_POINTS.length) % SPAWN_POINTS.length;
  const sp = SPAWN_POINTS[state.spawnIdx];

  chassisBody.position.set(sp.pos.x, sp.pos.y + 0.55, sp.pos.z);
  chassisBody.velocity.setZero();
  chassisBody.angularVelocity.setZero();
  chassisBody.quaternion.setFromEuler(0, sp.yaw, 0);
  chassisBody.wakeUp();

  state.rpm = state.engineOn ? CORSA_SPECS.IdleRPM : 0;
  state.gear = 1;
  state.currentSteer = 0;
  state.turboBoost = 0;
  state.skidIntensity = 0;
  state.isDrifting = false;
  state.driftAngleDeg = 0;
  state.lateralSpeedMs = 0;
  state.longitudinalLoad = 0;
  state.throttleInput = 0;
  state.brakeInput = 0;
  state.shiftCooldown = 0;
  state.shiftPhase = 'none';
  state.clutchEngagement = 1.0;
  state.revMatchTargetRPM = 0;
  state.absActive = false;
  state.tcsActive = false;
  state.surfaceType = 'asphalt';
  state.cuttingRev = false;
  prevSubstepFwdSpeed = 0;
  smoothPitchCouple = 0;
  smoothRollCouple = 0;
  smoothCamHeading = null;
  smoothCamZoomOffset = 0;
  smoothCamLatOffset = 0;
  for (let i = 0; i < 4; i++) state.wheelSkids[i] = 0;
  skidMarkSystem.resetWheelLinks();

  const backX = Math.sin(sp.yaw) * 4.2;
  const backZ = Math.cos(sp.yaw) * 4.2;
  camCurrentPos.set(sp.pos.x + backX, sp.pos.y + 2.0, sp.pos.z + backZ);
  camCurrentLook.set(sp.pos.x - backX * 0.5, sp.pos.y + 0.6, sp.pos.z - backZ * 0.5);

  document.querySelectorAll('.spawn-chip').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.spawn) === state.spawnIdx);
  });
}

// ============================================================================
// 8. DINÂMICA DO POWERTRAIN (FWD), DRIFT REAL NO FREIO DE MÃO E LUZES
// ============================================================================
const tempWheelPos = new THREE.Vector3();
const tempExhaustPos = new THREE.Vector3();
const tempChassisForward = new THREE.Vector3();
const tempChassisRight = new THREE.Vector3();
const tempChassisQuat = new THREE.Quaternion();
const tempVelVec = new THREE.Vector3();
const tempSmokeVel = new THREE.Vector3();
const tempExhaustVel = new THREE.Vector3();
const tempSkidHit = new THREE.Vector3();
const tempSkidNormal = new THREE.Vector3();
const tempSkidRight = new THREE.Vector3();
const tempSkidQuat = new THREE.Quaternion();

function getGearMaxSpeedKmh(gear) {
  const table = state.turboInstalled ? CORSA_SPECS.gearMaxSpeedKmhTurbo : CORSA_SPECS.gearMaxSpeedKmh;
  const val = table[String(gear)];
  return typeof val === 'number' ? val : 20;
}

function updateVehiclePhysicsAndEffects(dt) {
  if (!vehicle || !chassisBody) return;

  const inputForward = keys.w || state.touchInput.throttle > 0;
  const inputBackward = keys.s || state.touchInput.brake > 0;
  const inputHandbrake = keys.space || state.touchInput.handbrake > 0;
  const touchThrottleVal = state.touchInput.throttle;
  const touchBrakeVal = state.touchInput.brake;

  if (
    keys.w || keys.s || keys.a || keys.d || keys.space ||
    inputForward || inputBackward || inputHandbrake || Math.abs(state.touchInput.steer) > 0.05
  ) {
    chassisBody.wakeUp();
  }

  tempChassisQuat.set(
    chassisBody.quaternion.x,
    chassisBody.quaternion.y,
    chassisBody.quaternion.z,
    chassisBody.quaternion.w
  );
  tempChassisForward.set(0, 0, -1).applyQuaternion(tempChassisQuat);
  tempChassisRight.set(1, 0, 0).applyQuaternion(tempChassisQuat);

  tempVelVec.set(chassisBody.velocity.x, chassisBody.velocity.y, chassisBody.velocity.z);
  state.forwardSpeedMs = tempVelVec.dot(tempChassisForward);
  state.lateralSpeedMs = tempVelVec.dot(tempChassisRight);

  // Velocidade aparente calibrada para o ritmo real do Corsa
  state.speedKmh = (Math.abs(state.forwardSpeedMs) / WORLD_SPEED_SCALE) * 3.6;

  // Ângulo de derrapagem lateral (slip angle) e estado de drift para pneu dinâmico e áudio/fumaça
  const horizSpeedMs = Math.hypot(tempVelVec.x, tempVelVec.z);
  if (horizSpeedMs > 2.2) {
    const rawSlipRad = Math.atan2(state.lateralSpeedMs, Math.max(1.0, Math.abs(state.forwardSpeedMs)));
    const targetAngleDeg = THREE.MathUtils.radToDeg(rawSlipRad);
    state.driftAngleDeg = THREE.MathUtils.lerp(state.driftAngleDeg, targetAngleDeg, Math.min(1, dt * 14));
  } else {
    state.driftAngleDeg = THREE.MathUtils.lerp(state.driftAngleDeg, 0, Math.min(1, dt * 10));
  }
  const absSlipDeg = Math.abs(state.driftAngleDeg);
  state.isDrifting = horizSpeedMs > 3.5 && absSlipDeg > 10.5;

  // Transferência de peso longitudinal (+ freando/dianteira carrega, - acelerando/traseira carrega)
  const targetLongLoad = THREE.MathUtils.clamp(
    state.brakeInput - (state.engineOn && state.gear > 0 ? state.throttleInput * (0.55 + state.turboBoost * 0.35) : 0),
    -1.0,
    1.0
  );
  state.longitudinalLoad = THREE.MathUtils.lerp(state.longitudinalLoad, targetLongLoad, Math.min(1, dt * 7.5));

  let rawThrottle = 0.0;
  let rawBrake = 0.0;

  if (state.transmission === 'AUTO') {
    if (inputForward && !inputBackward) {
      if (state.gear === -1) {
        if (state.forwardSpeedMs < -0.30) {
          rawThrottle = 0.0;
          rawBrake = 1.0;
        } else {
          state.gear = 1;
          rawThrottle = Math.max(keys.w ? 1.0 : 0.0, touchThrottleVal);
          rawBrake = 0.0;
        }
      } else {
        if (state.gear === 0) state.gear = 1;
        rawThrottle = Math.max(keys.w ? 1.0 : 0.0, touchThrottleVal);
        rawBrake = 0.0;
      }
    } else if (inputBackward && !inputForward) {
      if (state.forwardSpeedMs > 0.30) {
        rawThrottle = 0.0;
        rawBrake = Math.max(keys.s ? 1.0 : 0.0, touchBrakeVal);
      } else {
        state.gear = -1;
        rawThrottle = Math.max(keys.s ? 0.85 : 0.0, touchBrakeVal * 0.85);
        rawBrake = 0.0;
      }
    } else if (inputForward && inputBackward) {
      rawThrottle = 0.0;
      rawBrake = 1.0;
    }
  } else {
    rawThrottle = Math.max(keys.w ? 1.0 : 0.0, touchThrottleVal);
    rawBrake = Math.max(keys.s ? 1.0 : 0.0, touchBrakeVal);
    if (state.gear > 0 && state.forwardSpeedMs < -0.30 && inputForward) {
      rawBrake = 0.5;
    }
  }

  state.throttleInput = THREE.MathUtils.lerp(state.throttleInput, rawThrottle, Math.min(1, dt * 10));
  state.brakeInput = THREE.MathUtils.lerp(state.brakeInput, rawBrake, Math.min(1, dt * 16));
  state.handbrakeInput = inputHandbrake ? 1.0 : 0.0;

  // Direção assistida progressiva com auto-alinhamento por caster e contra-esterço natural em drift
  let targetSteer = (keys.a ? 1 : 0) - (keys.d ? 1 : 0);
  if (Math.abs(state.touchInput.steer) > 0.01) {
    targetSteer = state.touchInput.steer;
  }
  const speedFactor = THREE.MathUtils.clamp(1.0 - (state.speedKmh / 185) * 0.62, 0.28, 1.0);
  const maxSteerNow = CORSA_SPECS.maxSteerAngle * speedFactor;

  let desiredSteer = targetSteer * maxSteerNow;
  if (Math.abs(targetSteer) < 0.05 && state.forwardSpeedMs > 3.5 && absSlipDeg > 6.5) {
    // Geometria de caster alinha as rodas dianteiras naturalmente na direção da trajetória durante derrapagem
    const casterSign = Math.sign(state.lateralSpeedMs);
    const maxCaster = state.handbrakeInput > 0.5 ? 0.72 : 0.48;
    const casterAssist = THREE.MathUtils.clamp((absSlipDeg - 6.5) / 24.0, 0, maxCaster) * maxSteerNow;
    desiredSteer = -casterSign * casterAssist;
  }

  const isReturningToCenter = Math.abs(targetSteer) < 0.05 || (targetSteer * state.currentSteer < 0);
  const isCounterSteering = absSlipDeg > 7.0 && targetSteer * state.lateralSpeedMs < 0;
  const speedCasterRate = 9.0 + THREE.MathUtils.clamp(state.speedKmh / 90, 0, 1.0) * 4.5;
  const steerRate = isCounterSteering ? 12.0 : isReturningToCenter ? speedCasterRate : 6.4;
  state.currentSteer = THREE.MathUtils.lerp(state.currentSteer, desiredSteer, Math.min(1, dt * steerRate));

  vehicle.setSteeringValue(state.currentSteer * (state.currentSteer > 0 ? 1.04 : 0.96), 0); // FL
  vehicle.setSteeringValue(state.currentSteer * (state.currentSteer < 0 ? 1.04 : 0.96), 1); // FR

  if (state.shiftCooldown > 0) {
    state.shiftCooldown = Math.max(0, state.shiftCooldown - dt);
    const shiftProg = 1.0 - state.shiftCooldown / Math.max(0.05, state.shiftDuration);
    state.clutchEngagement = THREE.MathUtils.smoothstep(shiftProg, 0.24, 1.0);
    if (state.shiftCooldown === 0) state.shiftPhase = 'none';
  } else {
    state.clutchEngagement = 1.0;
    state.shiftPhase = 'none';
  }

  // Escalonamento dinâmico de velocidades máximas por marcha (alonga automaticamente com Turbo ligado)
  const maxGearSpeedKmh = getGearMaxSpeedKmh(state.gear);
  const speedRatioInGear = maxGearSpeedKmh > 0 ? state.speedKmh / maxGearSpeedKmh : 0;

  const wheelDrivenRPM = CORSA_SPECS.IdleRPM + speedRatioInGear * (CORSA_SPECS.RedlineRPM - CORSA_SPECS.IdleRPM);

  if (!state.engineOn) {
    state.rpm = THREE.MathUtils.lerp(state.rpm, 0, dt * 4);
    state.cuttingRev = false;
  } else {
    if (state.gear === 0) {
      const targetFreeRPM = CORSA_SPECS.IdleRPM + state.throttleInput * (CORSA_SPECS.MaxRPM - CORSA_SPECS.IdleRPM + 350);
      state.rpm = THREE.MathUtils.lerp(state.rpm, targetFreeRPM, dt * (state.throttleInput > 0.05 ? 7.0 : 4.2));
    } else if (state.shiftPhase === 'downshift' && state.shiftCooldown > state.shiftDuration * 0.35) {
      // Ponta-taco / Rev-Match automático na redução: golpe de giro suave para igualar a marcha inferior
      state.rpm = THREE.MathUtils.lerp(state.rpm, state.revMatchTargetRPM, Math.min(1, dt * 18.0));
    } else if (state.shiftPhase === 'upshift' && state.shiftCooldown > 0) {
      // Inércia real do volante do motor na subida de marcha (queda progressiva do giro)
      state.rpm = THREE.MathUtils.lerp(state.rpm, Math.max(CORSA_SPECS.IdleRPM, wheelDrivenRPM), Math.min(1, dt * 6.8));
    } else {
      const clutchSlipRPM =
        state.throttleInput *
        (state.handbrakeInput > 0.5 && state.speedKmh < 15 ? 4900 : Math.max(0, 1.0 - state.speedKmh / 12) * 650);
      const targetEngagedRPM = Math.max(CORSA_SPECS.IdleRPM, wheelDrivenRPM + clutchSlipRPM);
      state.rpm = THREE.MathUtils.lerp(state.rpm, targetEngagedRPM, dt * 11.0);
    }

    if (state.transmission === 'AUTO' && state.shiftCooldown <= 0 && state.gear >= 1) {
      if (state.speedKmh >= maxGearSpeedKmh * 0.92 && state.gear < 5) {
        changeGear(state.gear + 1);
      } else if (state.gear > 1) {
        const prevGearMax = getGearMaxSpeedKmh(state.gear - 1);
        if (state.speedKmh < prevGearMax * 0.72) {
          changeGear(state.gear - 1);
        }
      }
    }

    const hitGearSpeedLimiter = state.gear !== 0 && state.speedKmh >= maxGearSpeedKmh - 0.6;
    if (
      state.throttleInput > 0.60 &&
      (state.rpm >= CORSA_SPECS.RedlineRPM ||
        hitGearSpeedLimiter ||
        (state.handbrakeInput > 0.5 && state.throttleInput > 0.8 && state.speedKmh < 18))
    ) {
      state.cuttingRev = true;
      const osc = Math.sin(performance.now() * 0.065) * 150;
      state.rpm = CORSA_SPECS.RedlineRPM + 140 + osc;
    } else {
      state.cuttingRev = false;
      state.rpm = THREE.MathUtils.clamp(state.rpm, CORSA_SPECS.IdleRPM, CORSA_SPECS.MaxRPM);
    }
  }

  // ==========================================================================
  // TURBOCOMPRESSOR PROGRESSIVO (SPOOL-UP AOS POUCOS, ASSOVIO E PRESSÃO DE 0 A 1.5 BAR)
  // ==========================================================================
  if (state.turboInstalled && state.engineOn) {
    // Para encher a turbina aos poucos, precisa de giro (>2.100 RPM), acelerador e marcha engatada
    const hasEngineLoad = state.gear !== 0 && state.throttleInput > 0.25;
    const rpmSpoolRatio = THREE.MathUtils.clamp((state.rpm - 2100) / 3400, 0, 1);

    if (hasEngineLoad && rpmSpoolRatio > 0) {
      // Pressão alvo proporcional ao pedal do acelerador e à rotação do motor
      const targetBoost = THREE.MathUtils.clamp(state.throttleInput * (0.35 + rpmSpoolRatio * 0.70), 0, 1.0);
      const spoolRate = 0.82 + rpmSpoolRatio * 0.60;
      if (targetBoost > state.turboBoost) {
        state.turboBoost = Math.min(1.0, state.turboBoost + dt * spoolRate);
      } else {
        // Reduz pressão se aliviar o pé
        state.turboBoost = Math.max(0.0, state.turboBoost - dt * 1.8);
      }
    } else {
      // Se tirar o pé bruscamente com o turbo cheio (>= 0.65), a válvula de alívio espirra imediatamente!
      if (state.turboBoost >= 0.65 && state.throttleInput < 0.20 && state.shiftCooldown <= 0) {
        triggerTurboBlowOff();
      } else {
        // Esvazia gradualmente quando sem carga
        state.turboBoost = Math.max(0.0, state.turboBoost - dt * 2.6);
      }
    }
  } else {
    state.turboBoost = 0.0;
  }

  const isTurboFull = state.turboInstalled && state.turboBoost >= 0.82;
  const isFrontWheelSpinningTurbo =
    isTurboFull &&
    state.throttleInput > 0.65 &&
    state.gear >= 1 &&
    state.gear <= 3 &&
    state.speedKmh < 95;

  // ==========================================================================
  // SUPERFÍCIES, SENSIBILIDADE DE CARGA, DIFERENCIAL ABERTO/LSD, ABS & TCS
  // ==========================================================================
  const isHandbraking = state.handbrakeInput > 0.5;
  const nominalWheelLoad = (CORSA_SPECS.mass * 9.81) / 4.0;
  const wheelSurfaces = ['asphalt', 'asphalt', 'asphalt', 'asphalt'];
  const surfaceCounts = { asphalt: 0, bridge: 0, sidewalk: 0, dirt: 0 };
  const wheelLoads = [nominalWheelLoad, nominalWheelLoad, nominalWheelLoad, nominalWheelLoad];

  for (let i = 0; i < 4; i++) {
    const wi = vehicle.wheelInfos[i];
    if (wi && wi.isInContact) {
      const hitBody = wi.raycastResult && wi.raycastResult.body;
      const sId = (hitBody && hitBody.surfaceType) || 'asphalt';
      wheelSurfaces[i] = sId;
      surfaceCounts[sId] = (surfaceCounts[sId] || 0) + 1;
      wheelLoads[i] = THREE.MathUtils.clamp(wi.suspensionForce || nominalWheelLoad, nominalWheelLoad * 0.15, nominalWheelLoad * 2.5);
    }
  }

  let dominantSurface = 'asphalt';
  if (surfaceCounts.dirt >= 2) dominantSurface = 'dirt';
  else if (surfaceCounts.bridge >= 2) dominantSurface = 'bridge';
  else if (surfaceCounts.sidewalk >= 2) dominantSurface = 'sidewalk';
  else if (surfaceCounts.dirt === 1 && surfaceCounts.asphalt <= 2) dominantSurface = wheelSurfaces[0] !== 'asphalt' ? wheelSurfaces[0] : wheelSurfaces[1];
  state.surfaceType = dominantSurface;
  const activeSurfProfile = SURFACE_PROFILES[dominantSurface] || SURFACE_PROFILES.asphalt;

  // Assistência 1: ABS (Freio Anti-Travamento com modulação a ~13.5 Hz preservando esterço)
  const isABSEngaging = state.absEnabled && state.brakeInput > 0.68 && state.speedKmh > 12 && !isHandbraking;
  state.absActive = isABSEngaging;
  const absBrakePulse = isABSEngaging ? (0.74 + 0.28 * Math.sin(performance.now() * 0.085)) : 1.0;

  // Assistência 2: Controle de Tração (TCS — corta excesso de torque quando há destracionamento dianteiro)
  const isFastLaunchAccel =
    state.engineOn &&
    state.throttleInput > 0.85 &&
    state.gear === 1 &&
    state.speedKmh > 0.5 &&
    state.speedKmh < 12;
  const wantsWheelSpin =
    state.engineOn &&
    state.gear > 0 &&
    state.throttleInput > 0.58 &&
    !isHandbraking &&
    (isFrontWheelSpinningTurbo || isFastLaunchAccel || (state.forwardSpeedMs > 2.5 && absSlipDeg > 13.5));

  state.tcsActive = state.tcsEnabled && wantsWheelSpin;
  const tcsTorqueMultiplier = state.tcsActive ? (isFrontWheelSpinningTurbo ? 0.44 : 0.62) : 1.0;

  // Modelo dinâmico de aderência dos pneus (círculo de atrito + carga vertical + tipo de superfície)
  const baseGrip = CORSA_SPECS.frictionSlipNormal;
  const slipDropFactor = THREE.MathUtils.clamp((absSlipDeg - 13.0) / 32.0, 0, 1.0);
  const lateralGripPenalty = slipDropFactor * 0.28;

  const brakeFrontBonus = Math.max(0, state.longitudinalLoad) * 0.06 + (isABSEngaging ? 0.09 : 0.0);
  const brakeRearUnloading = Math.max(0, state.longitudinalLoad) * 0.16;
  const accelFrontUnloading = Math.max(0, -state.longitudinalLoad) * 0.10;

  const baseDynamicFront = THREE.MathUtils.clamp(
    baseGrip + brakeFrontBonus - accelFrontUnloading - lateralGripPenalty * 0.90,
    1.22,
    1.80
  );
  const baseDynamicRear = THREE.MathUtils.clamp(
    baseGrip - brakeRearUnloading - lateralGripPenalty * 1.05,
    1.18,
    1.72
  );

  // Sensibilidade à carga vertical (Load Sensitivity): pneu sobrecarregado perde eficiência proporcionalmente
  const loadRatioFL = wheelLoads[0] / nominalWheelLoad;
  const loadRatioFR = wheelLoads[1] / nominalWheelLoad;
  const loadRatioRL = wheelLoads[2] / nominalWheelLoad;
  const loadRatioRR = wheelLoads[3] / nominalWheelLoad;
  const loadSens = (lr) => THREE.MathUtils.clamp(1.06 - (lr - 1.0) * 0.11, 0.82, 1.14);

  const surfGrip0 = (SURFACE_PROFILES[wheelSurfaces[0]] || activeSurfProfile).gripMul;
  const surfGrip1 = (SURFACE_PROFILES[wheelSurfaces[1]] || activeSurfProfile).gripMul;
  const surfGrip2 = (SURFACE_PROFILES[wheelSurfaces[2]] || activeSurfProfile).gripMul;
  const surfGrip3 = (SURFACE_PROFILES[wheelSurfaces[3]] || activeSurfProfile).gripMul;

  // Diferencial aberto (Aspirado) faz a roda dianteira interna aliviada perder tração mais cedo em curva forte
  const openDiffSlipFL = !state.turboInstalled && state.throttleInput > 0.65 && loadRatioFL < 0.78 ? 0.84 : 1.0;
  const openDiffSlipFR = !state.turboInstalled && state.throttleInput > 0.65 && loadRatioFR < 0.78 ? 0.84 : 1.0;

  if (isHandbraking) {
    // Freio de mão realista e controlável: trava as traseiras preservando aderência lateral mínima para sustentar o drift sem rodar
    const frontHandbrakeTrim = absSlipDeg > 20 ? THREE.MathUtils.clamp(1.0 - (absSlipDeg - 20) * 0.012, 0.76, 1.0) : 1.0;
    const frontDriftSlip = baseGrip * 0.92 * frontHandbrakeTrim;
    vehicle.wheelInfos[0].frictionSlip = frontDriftSlip * surfGrip0;
    vehicle.wheelInfos[1].frictionSlip = frontDriftSlip * surfGrip1;
    vehicle.wheelInfos[2].frictionSlip = CORSA_SPECS.frictionSlipHandbrake * surfGrip2;
    vehicle.wheelInfos[3].frictionSlip = CORSA_SPECS.frictionSlipHandbrake * surfGrip3;
  } else if (isFrontWheelSpinningTurbo && !state.tcsActive) {
    // SÓ QUANDO O TURBO ENCHER (e sem TCS segurando): o carro destraciona a frente violentamente!
    vehicle.wheelInfos[0].frictionSlip = 0.72 * surfGrip0;
    vehicle.wheelInfos[1].frictionSlip = 0.72 * surfGrip1;
    vehicle.wheelInfos[2].frictionSlip = baseDynamicRear * surfGrip2 * loadSens(loadRatioRL);
    vehicle.wheelInfos[3].frictionSlip = baseDynamicRear * surfGrip3 * loadSens(loadRatioRR);
  } else if (state.tcsActive && isFrontWheelSpinningTurbo) {
    // TCS modula o escorregamento dianteiro mantendo o carro controlável
    vehicle.wheelInfos[0].frictionSlip = 1.24 * surfGrip0 * loadSens(loadRatioFL);
    vehicle.wheelInfos[1].frictionSlip = 1.24 * surfGrip1 * loadSens(loadRatioFR);
    vehicle.wheelInfos[2].frictionSlip = baseDynamicRear * surfGrip2 * loadSens(loadRatioRL);
    vehicle.wheelInfos[3].frictionSlip = baseDynamicRear * surfGrip3 * loadSens(loadRatioRR);
  } else {
    vehicle.wheelInfos[0].frictionSlip = baseDynamicFront * surfGrip0 * loadSens(loadRatioFL) * openDiffSlipFL;
    vehicle.wheelInfos[1].frictionSlip = baseDynamicFront * surfGrip1 * loadSens(loadRatioFR) * openDiffSlipFR;
    vehicle.wheelInfos[2].frictionSlip = baseDynamicRear * surfGrip2 * loadSens(loadRatioRL);
    vehicle.wheelInfos[3].frictionSlip = baseDynamicRear * surfGrip3 * loadSens(loadRatioRR);
  }

  // Curva de Torque Realista + Inércia de Embreagem + Limitador Físico de Velocidade por Marcha
  const rpmNorm = THREE.MathUtils.clamp((state.rpm - 800) / 5800, 0, 1);
  const torqueCurve = 0.55 + 0.45 * Math.sin(rpmNorm * Math.PI * 0.85);
  let wheelDriveForce = 0;

  if (state.engineOn && state.gear !== 0) {
    const baseGearForce = CORSA_SPECS.gearDriveForces[String(state.gear)] || 0;

    let speedLimiterFactor = 1.0;
    if (state.speedKmh >= maxGearSpeedKmh) {
      speedLimiterFactor = 0.0;
    } else if (state.speedKmh > maxGearSpeedKmh - 2.5) {
      speedLimiterFactor = (maxGearSpeedKmh - state.speedKmh) / 2.5;
    }

    let turboBoostFactor = 1.0;
    if (state.turboInstalled) {
      if (isTurboFull) {
        turboBoostFactor = 1.95;
      } else {
        turboBoostFactor = 1.0 + state.turboBoost * 0.30;
      }
    }

    wheelDriveForce =
      state.throttleInput *
      baseGearForce *
      torqueCurve *
      speedLimiterFactor *
      turboBoostFactor *
      state.clutchEngagement *
      tcsTorqueMultiplier;

    if (state.speedKmh > maxGearSpeedKmh + 1.5) {
      wheelDriveForce = -Math.sign(state.forwardSpeedMs) * 1650 * state.clutchEngagement;
    } else if (state.throttleInput < 0.05 && state.speedKmh > 4) {
      // Freio-motor realista escalonado por relação de marcha (1ª segura mais que 5ª)
      const gearEngineBrakeRatio = 0.60 + (6 - Math.min(5, Math.abs(state.gear))) * 0.14;
      wheelDriveForce = -Math.sign(state.forwardSpeedMs) * (205 + rpmNorm * 325) * gearEngineBrakeRatio * state.clutchEngagement;
    }
  }

  // Diferencial Dianteiro: Aberto (Aspirado) vs. Helicoidal LSD (Kit Turbo)
  let driveForceL = wheelDriveForce;
  let driveForceR = wheelDriveForce;
  if (wheelDriveForce > 0) {
    const frontLoadSum = Math.max(400, wheelLoads[0] + wheelLoads[1]);
    if (state.turboInstalled) {
      // LSD Helicoidal (45% lock): transfere torque da roda interna leve para a externa carregada
      const shareL = wheelLoads[0] / frontLoadSum;
      const shareR = wheelLoads[1] / frontLoadSum;
      driveForceL = wheelDriveForce * (0.55 + shareL * 0.90);
      driveForceR = wheelDriveForce * (0.55 + shareR * 0.90);
    } else {
      // Diferencial aberto: tração máxima limitada pela roda interna mais aliviada em curvas fechadas
      const minFrontRatio = Math.min(wheelLoads[0], wheelLoads[1]) / (frontLoadSum * 0.5);
      const openDiffCap = THREE.MathUtils.clamp(minFrontRatio * 1.18, 0.62, 1.0);
      driveForceL = wheelDriveForce * openDiffCap;
      driveForceR = wheelDriveForce * openDiffCap;
    }
  }

  // TRAÇÃO DIANTEIRA (FWD): Força aplicada nas rodas 0 (FL) e 1 (FR) segundo o diferencial ativo
  vehicle.applyEngineForce(driveForceL, 0);
  vehicle.applyEngineForce(driveForceR, 1);
  vehicle.applyEngineForce(0, 2);
  vehicle.applyEngineForce(0, 3);

  // Freio de serviço progressivo calibrado para 920kg + modulação ABS se ativado
  const speedBrakeFactor = THREE.MathUtils.clamp(0.60 + (state.speedKmh / 140) * 0.40, 0.60, 1.0);
  const serviceBrakeFront = state.brakeInput * 27.8 * speedBrakeFactor * absBrakePulse;
  const serviceBrakeRear = state.brakeInput * 16.3 * speedBrakeFactor * absBrakePulse;
  // Freio de mão mecânico progressivo no eixo traseiro (trava as rodas com margem cinética no círculo de atrito)
  const handbrakeRear = isHandbraking ? 46 : 0;

  vehicle.setBrake(serviceBrakeFront, 0);
  vehicle.setBrake(serviceBrakeFront, 1);
  vehicle.setBrake(Math.max(serviceBrakeRear, handbrakeRear), 2);
  vehicle.setBrake(Math.max(serviceBrakeRear, handbrakeRear), 3);

  // ==========================================================================
  // ATUALIZAÇÃO EM TEMPO REAL DOS FARÓIS, LANTERNA, 3º BRAKE LIGHT E RÉ
  // ==========================================================================
  if (headlightMat) {
    headlightMat.emissive.setHex(state.headlightsOn ? 0xffd56b : 0x000000);
    headlightMat.emissiveIntensity = state.headlightsOn ? 1.15 : 0.0;
  }
  if (headlightSpotL && headlightSpotR) {
    const beamPower = state.headlightsOn ? 4.2 : 0.0;
    headlightSpotL.intensity = beamPower;
    headlightSpotR.intensity = beamPower;
    headlightSpotL.visible = state.headlightsOn;
    headlightSpotR.visible = state.headlightsOn;
  }

  const isBrakingNow = state.brakeInput > 0.08 || state.handbrakeInput > 0.08;
  if (brakeLightMat) {
    brakeLightMat.emissiveIntensity = isBrakingNow ? 1.65 : state.headlightsOn ? 0.55 : 0.0;
  }
  if (thirdBrakeLightMat) {
    thirdBrakeLightMat.emissiveIntensity = isBrakingNow ? 1.80 : 0.0;
  }
  if (brakeSpotL && brakeSpotR) {
    const brakeSpotIntensity = isBrakingNow ? 1.85 : 0.0;
    brakeSpotL.intensity = brakeSpotIntensity;
    brakeSpotR.intensity = brakeSpotIntensity;
    brakeSpotL.visible = isBrakingNow;
    brakeSpotR.visible = isBrakingNow;
  }

  const isReverseEngaged = state.gear === -1;
  if (reverseLightMat) {
    reverseLightMat.emissiveIntensity = isReverseEngaged ? 1.25 : 0.0;
  }
  if (reverseSpotL && reverseSpotR) {
    const revIntensity = isReverseEngaged ? 2.4 : 0.0;
    reverseSpotL.intensity = revIntensity;
    reverseSpotR.intensity = revIntensity;
    reverseSpotL.visible = isReverseEngaged;
    reverseSpotR.visible = isReverseEngaged;
  }

  // Velocidade angular real de cada uma das 4 rodas
  for (let i = 0; i < 4; i++) {
    let wOmega = state.forwardSpeedMs / CORSA_SPECS.wheelRadius;
    if (i >= 2 && isHandbraking) {
      wOmega = 0; // Rodas traseiras travadas no freio de mão
    } else if (state.brakeInput > 0.70 && state.speedKmh > 25) {
      // Desaceleração realista das rodas sob frenagem forte (modulação ABS visual)
      const brakeSlipScale = 1.0 - THREE.MathUtils.clamp((state.brakeInput - 0.65) * 1.15, 0, 0.45);
      wOmega *= brakeSlipScale;
    }
    if (i < 2 && state.engineOn && state.gear === 1 && state.throttleInput > 0.85 && state.speedKmh < 10) {
      wOmega += state.throttleInput * 7.0;
    }
    // SÓ QUANDO O TURBO ENCHER: Rodas dianteiras giram destracionando em altíssima rotação!
    if (i < 2 && isFrontWheelSpinningTurbo) {
      wOmega += 24.0 * state.turboBoost;
    }
    wheelSpinAngles[i] -= wOmega * dt;
  }

  const isHardBrakingHighSpeed = state.brakeInput > 0.78 && state.speedKmh > 18 && !isABSEngaging;
  const isCorneringHard = horizSpeedMs > 5.0 && absSlipDeg > 11.5 && !isHandbraking;
  const lateralCornerSkid = isCorneringHard
    ? THREE.MathUtils.clamp((absSlipDeg - 11.5) / 22.0, 0.15, 0.88)
    : 0;
  const isFastLaunchBurnout =
    state.engineOn &&
    state.throttleInput > 0.90 &&
    !state.tcsActive &&
    ((state.gear === 1 && state.speedKmh > 0.5 && state.speedKmh < 9) ||
      (isHandbraking && state.gear !== 0 && state.speedKmh < 16));

  let maxSkid = 0;

  for (let i = 0; i < 4; i++) {
    const wi = vehicle.wheelInfos[i];
    const suspTravel = THREE.MathUtils.clamp(
      1.0 - (wi.suspensionLength || CORSA_SPECS.suspensionRestLength) / CORSA_SPECS.suspensionRestLength,
      0.05,
      1.0
    );
    state.wheelCompression[i] = suspTravel;

    let wSkid = 0;
    if (wi.isInContact) {
      if (i < 2 && isFastLaunchBurnout) {
        wSkid = Math.max(wSkid, 0.78);
      }
      // SÓ QUANDO O TURBO ENCHER (sem TCS ativo): as rodas dianteiras destracionam com fumaça intensa
      if (i < 2 && isFrontWheelSpinningTurbo && !state.tcsActive) {
        wSkid = Math.max(wSkid, 0.96);
      }
      if (isHardBrakingHighSpeed) {
        // Travamento progressivo sob frenagem forte (ABS OFF)
        const brakeSkid = THREE.MathUtils.clamp((state.speedKmh - 14) / 48, 0.34, 0.95);
        wSkid = Math.max(wSkid, i < 2 ? brakeSkid : brakeSkid * 0.72);
      } else if (isABSEngaging) {
        // ABS modulando: apenas leve chiado intermitente no limite sem travar pneu
        wSkid = Math.max(wSkid, 0.22);
      }
      if (i >= 2 && isHandbraking && state.speedKmh > 3.5) {
        wSkid = Math.max(wSkid, THREE.MathUtils.clamp((state.speedKmh - 2) / 14, 0.45, 0.90));
      }
      if (lateralCornerSkid > 0) {
        // Pneus carregados cantam progressivamente ao entrar forte nas curvas
        wSkid = Math.max(wSkid, Math.min(0.88, lateralCornerSkid * (0.85 + suspTravel * 0.25)));
      }
    }

    state.wheelSkids[i] = wSkid;
    maxSkid = Math.max(maxSkid, wSkid);

    // Registra fitas contínuas de marca de pneu no ponto exato de contato com o asfalto
    const rr = wi.raycastResult;
    if (wi.isInContact && rr && rr.hasHit) {
      tempSkidHit.set(rr.hitPointWorld.x, rr.hitPointWorld.y, rr.hitPointWorld.z);
      tempSkidNormal.set(rr.hitNormalWorld.x, rr.hitNormalWorld.y, rr.hitNormalWorld.z).normalize();
      tempSkidQuat.set(
        wi.worldTransform.quaternion.x,
        wi.worldTransform.quaternion.y,
        wi.worldTransform.quaternion.z,
        wi.worldTransform.quaternion.w
      );
      tempSkidRight.set(1, 0, 0).applyQuaternion(tempSkidQuat);
      tempSkidRight.addScaledVector(tempSkidNormal, -tempSkidRight.dot(tempSkidNormal));
      if (tempSkidRight.lengthSq() > 1e-4) {
        tempSkidRight.normalize();
      } else {
        tempSkidRight.copy(tempChassisRight);
      }
      skidMarkSystem.recordWheel(i, tempSkidHit, tempSkidNormal, tempSkidRight, wSkid);
    } else {
      skidMarkSystem.recordWheel(i, null, tempSkidNormal, tempChassisRight, 0);
    }

    const wSurf = SURFACE_PROFILES[wheelSurfaces[i]] || activeSurfProfile;
    const isDustyWheel = wheelSurfaces[i] === 'dirt' && wi.isInContact && state.speedKmh > 18;
    if ((wSkid > 0.28 || isDustyWheel) && Math.random() < Math.max(wSkid * 0.96, isDustyWheel ? 0.35 : 0)) {
      const wTransform = wi.worldTransform;
      const effSkid = Math.max(wSkid, isDustyWheel ? 0.36 : 0);
      const puffCount = effSkid > 0.72 && state.graphicsQuality !== 'low' ? 2 : 1;
      for (let p = 0; p < puffCount; p++) {
        tempWheelPos.set(
          wTransform.position.x + (Math.random() - 0.5) * 0.16,
          wTransform.position.y - CORSA_SPECS.wheelRadius + 0.06,
          wTransform.position.z + (Math.random() - 0.5) * 0.16
        );
        const lateralOut = (i % 2 === 0 ? -1 : 1) * (0.35 + Math.random() * 0.45) * effSkid;
        tempSmokeVel.set(
          -chassisBody.velocity.x * 0.24 + tempChassisRight.x * lateralOut + (Math.random() - 0.5) * 0.95,
          0.42 + Math.random() * 0.52 + effSkid * 0.25,
          -chassisBody.velocity.z * 0.24 + tempChassisRight.z * lateralOut + (Math.random() - 0.5) * 0.95
        );
        smokeSystem.spawn(tempWheelPos, tempSmokeVel, {
          startScale: 0.24 + effSkid * 0.08,
          endScale: 1.75 + effSkid * 1.15 + Math.random() * 0.45,
          opacity: (isDustyWheel ? 0.26 : 0.34) + effSkid * 0.18,
          maxAge: 1.15 + Math.random() * 0.85,
          buoyancy: 0.65 + Math.random() * 0.35,
          drag: 0.36,
          colorHex: wSurf.smokeColorHex
        });
      }
    }
  }
  skidMarkSystem.commitUpdates();

  // Torque-steer real pelo desequilíbrio do diferencial dianteiro + surto de turbo cheio sem TCS
  if (driveForceR !== driveForceL) {
    const torqueDiff = THREE.MathUtils.clamp((driveForceR - driveForceL) / 3400, -0.40, 0.40);
    chassisBody.angularVelocity.y += torqueDiff * dt;
  }
  if (isFrontWheelSpinningTurbo && !state.tcsActive) {
    const tq = Math.sin(performance.now() * 0.006) * 0.9 + Math.sin(performance.now() * 0.0137) * 0.5;
    chassisBody.angularVelocity.y += tq * 0.24 * dt;
  }

  state.skidIntensity = THREE.MathUtils.lerp(state.skidIntensity, maxSkid, Math.min(1, dt * 12));

  if (state.engineOn) {
    const exhaustRate = 0.35 + state.throttleInput * 0.55 + (state.cuttingRev ? 0.35 : 0);
    if (Math.random() < exhaustRate) {
      carAudio.exhaustAnchor.getWorldPosition(tempExhaustPos);
      const jetSpeed = 1.2 + state.throttleInput * 2.8 + (state.cuttingRev ? 1.8 : 0);
      tempExhaustVel.copy(tempChassisForward).multiplyScalar(-jetSpeed);
      tempExhaustVel.x += (Math.random() - 0.5) * 0.30;
      tempExhaustVel.y += 0.20 + Math.random() * 0.25;
      tempExhaustVel.z += (Math.random() - 0.5) * 0.30;

      smokeSystem.spawn(tempExhaustPos, tempExhaustVel, {
        startScale: 0.08,
        endScale: state.cuttingRev ? 0.85 : 0.40 + state.throttleInput * 0.30,
        opacity: state.cuttingRev ? 0.38 : 0.14 + state.throttleInput * 0.16,
        maxAge: 0.50 + Math.random() * 0.40,
        colorHex: state.cuttingRev ? 0x94a3b8 : 0xcbd5e1
      });
    }
  }
}

const tempSteerQuat = new THREE.Quaternion();
const tempSpinQuat = new THREE.Quaternion();
const axisY = new THREE.Vector3(0, 1, 0);
const axisX = new THREE.Vector3(1, 0, 0);

function syncVisualMeshes() {
  if (!vehicle || !corsaChassisVisual) return;

  corsaChassisVisual.position.set(
    chassisBody.position.x,
    chassisBody.position.y,
    chassisBody.position.z
  );
  corsaChassisVisual.quaternion.set(
    chassisBody.quaternion.x,
    chassisBody.quaternion.y,
    chassisBody.quaternion.z,
    chassisBody.quaternion.w
  );

  for (let i = 0; i < 4; i++) {
    vehicle.updateWheelTransform(i);
    const wi = vehicle.wheelInfos[i];
    const t = wi.worldTransform;
    const wg = corsaWheelVisuals[i];
    if (wg) {
      wg.position.set(t.position.x, t.position.y, t.position.z);

      tempSteerQuat.setFromAxisAngle(axisY, wi.steering || 0);
      tempSpinQuat.setFromAxisAngle(axisX, wheelSpinAngles[i]);

      wg.quaternion.copy(corsaChassisVisual.quaternion).multiply(tempSteerQuat).multiply(tempSpinQuat);
    }
  }

  if (envTimeSystem) {
    const lightDir = envTimeSystem.activeLightDir;
    sunLight.position.copy(corsaChassisVisual.position).addScaledVector(lightDir, 85.0);
    sunLight.target.position.copy(corsaChassisVisual.position);
  } else {
    sunLight.position.set(
      chassisBody.position.x + 35,
      chassisBody.position.y + 70,
      chassisBody.position.z + 25
    );
    sunLight.target.position.copy(corsaChassisVisual.position);
  }
}

// ============================================================================
// 9. CÂMERA COM DISTÂNCIA EQUILIBRADA E CAMPO DE VISÃO SUAVE
// ============================================================================
const camCurrentPos = new THREE.Vector3();
const camCurrentLook = new THREE.Vector3();
const tempCamForward = new THREE.Vector3();
const tempCamBehind = new THREE.Vector3();
const tempCamOffset = new THREE.Vector3();
const tempCamLookOffset = new THREE.Vector3();
let smoothCamHeading = null;
let smoothCamZoomOffset = 0;
let smoothCamLatOffset = 0;

function updateCamera(dt) {
  if (!corsaChassisVisual) return;

  const carPos = corsaChassisVisual.position;
  const carQuat = corsaChassisVisual.quaternion;

  tempCamForward.set(0, 0, -1).applyQuaternion(carQuat);
  // Atenua o pitch na câmera de perseguição para o jogador enxergar o mergulho/levantar da carroceria sobre o horizonte
  tempCamForward.y *= 0.45;
  tempCamForward.normalize();

  if (!smoothCamHeading) {
    smoothCamHeading = tempCamForward.clone();
  } else {
    const camTrackRate = 5.4 + Math.min(state.speedKmh / 160, 1.0) * 2.4;
    smoothCamHeading.lerp(tempCamForward, Math.min(1.0, dt * camTrackRate)).normalize();
  }

  // Sensação elástica de força G longitudinal (acelerando afasta levemente, freando aproxima) e lateral nas curvas
  const targetZoomOffset = -state.longitudinalLoad * 0.28 + Math.min(state.speedKmh / 180, 1.0) * 0.48;
  smoothCamZoomOffset = THREE.MathUtils.lerp(smoothCamZoomOffset, targetZoomOffset, Math.min(1.0, dt * 5.0));

  const targetLatOffset = THREE.MathUtils.clamp(state.lateralSpeedMs * 0.045, -0.32, 0.32);
  smoothCamLatOffset = THREE.MathUtils.lerp(smoothCamLatOffset, targetLatOffset, Math.min(1.0, dt * 4.5));

  const targetFov = state.cameraMode === 0
    ? 58 + Math.min(state.speedKmh / 200, 1.0) * 6.5 + Math.max(0, -state.longitudinalLoad) * 2.5
    : 58;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, Math.min(1.0, dt * 4.0));
    camera.updateProjectionMatrix();
  }

  if (state.cameraMode === 0) {
    // 0: PERSEGUIÇÃO DINÂMICA (permite ver rolagem, balanço da traseira, mergulho e agachamento da suspensão)
    const dist = (5.25 + smoothCamZoomOffset) * CAR_SCALE;
    const height = 1.60 * CAR_SCALE;
    tempCamBehind.copy(smoothCamHeading).multiplyScalar(-1);
    tempCamBehind.applyAxisAngle(axisY, state.orbitYaw);

    camCurrentPos.copy(carPos).addScaledVector(tempCamBehind, dist);
    camCurrentPos.addScaledVector(tempChassisRight, smoothCamLatOffset * CAR_SCALE);
    camCurrentPos.y = carPos.y + height + Math.sin(state.orbitPitch) * (1.5 * CAR_SCALE);
    camCurrentLook.copy(carPos);
    camCurrentLook.y += 0.34 * CAR_SCALE;
    camCurrentLook.addScaledVector(smoothCamHeading, 1.45 * CAR_SCALE);
  } else if (state.cameraMode === 1) {
    // 1: CAPÔ (MOTOR)
    tempCamOffset.set(0, 0.68 * CAR_SCALE, -0.38 * CAR_SCALE).applyQuaternion(carQuat);
    camCurrentPos.copy(carPos).add(tempCamOffset);
    tempCamLookOffset.copy(tempCamForward).applyAxisAngle(axisY, state.orbitYaw);
    camCurrentLook.copy(camCurrentPos).addScaledVector(tempCamLookOffset, 10.0);
  } else if (state.cameraMode === 2) {
    // 2: ESCAPAMENTO
    tempCamOffset.set(-0.62 * CAR_SCALE, 0.28 * CAR_SCALE, 3.05 * CAR_SCALE).applyQuaternion(carQuat);
    camCurrentPos.copy(carPos).add(tempCamOffset);
    tempCamLookOffset.set(-0.25 * CAR_SCALE, 0.05 * CAR_SCALE, 0.8 * CAR_SCALE).applyQuaternion(carQuat);
    camCurrentLook.copy(carPos).add(tempCamLookOffset);
  } else {
    // 3: ÓRBITA LIVRE 3D
    const radius = 3.9 * CAR_SCALE;
    const angle = state.orbitYaw;
    tempCamOffset.set(
      Math.sin(angle) * radius,
      (1.15 + Math.sin(state.orbitPitch) * 1.4) * CAR_SCALE,
      Math.cos(angle) * radius
    ).applyQuaternion(carQuat);
    camCurrentPos.copy(carPos).add(tempCamOffset);
    camCurrentLook.copy(carPos);
    camCurrentLook.y += 0.22 * CAR_SCALE;
  }

  camera.position.copy(camCurrentPos);
  camera.lookAt(camCurrentLook);
}

// ============================================================================
// 10. PAINEL DE INSTRUMENTOS (CONTA-GIROS ANALÓGICO CANVAS + TELEMETRIA HUD)
// ============================================================================
const tachoCanvas = document.getElementById('tachometer-canvas');
const tachoCtx = tachoCanvas.getContext('2d');

function drawTachometer() {
  const w = tachoCanvas.width;
  const h = tachoCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.5 - 12;

  tachoCtx.clearRect(0, 0, w, h);

  const startAngle = Math.PI * 0.75;
  const endAngle = Math.PI * 2.25;
  const totalSweep = endAngle - startAngle;

  tachoCtx.beginPath();
  tachoCtx.arc(cx, cy, r, startAngle, endAngle);
  tachoCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  tachoCtx.lineWidth = 11;
  tachoCtx.lineCap = 'round';
  tachoCtx.stroke();

  const redStart = startAngle + (6000 / 7000) * totalSweep;
  tachoCtx.beginPath();
  tachoCtx.arc(cx, cy, r, redStart, endAngle);
  tachoCtx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
  tachoCtx.lineWidth = 11;
  tachoCtx.stroke();

  const rpmClamped = THREE.MathUtils.clamp(state.rpm, 0, 7000);
  const rpmAngle = startAngle + (rpmClamped / 7000) * totalSweep;
  if (rpmClamped > 50) {
    tachoCtx.beginPath();
    tachoCtx.arc(cx, cy, r, startAngle, rpmAngle);
    tachoCtx.strokeStyle = state.cuttingRev || state.rpm >= CORSA_SPECS.RedlineRPM ? '#ef4444' : '#38bdf8';
    tachoCtx.lineWidth = 11;
    tachoCtx.lineCap = 'round';
    tachoCtx.stroke();
  }

  tachoCtx.font = 'bold 11px Segoe UI, sans-serif';
  tachoCtx.textAlign = 'center';
  tachoCtx.textBaseline = 'middle';

  for (let i = 0; i <= 7; i++) {
    const a = startAngle + (i / 7) * totalSweep;
    const x1 = cx + Math.cos(a) * (r - 9);
    const y1 = cy + Math.sin(a) * (r - 9);
    const x2 = cx + Math.cos(a) * (r + 3);
    const y2 = cy + Math.sin(a) * (r + 3);

    tachoCtx.beginPath();
    tachoCtx.moveTo(x1, y1);
    tachoCtx.lineTo(x2, y2);
    tachoCtx.strokeStyle = i >= 6 ? '#ef4444' : '#cbd5e1';
    tachoCtx.lineWidth = 2.2;
    tachoCtx.stroke();

    const tx = cx + Math.cos(a) * (r - 22);
    const ty = cy + Math.sin(a) * (r - 22);
    tachoCtx.fillStyle = i >= 6 ? '#ef4444' : '#94a3b8';
    tachoCtx.fillText(String(i), tx, ty);
  }

  // Medidor interno de Pressão do Turbo (0.0 a 1.5 BAR)
  if (state.turboInstalled) {
    const rTurbo = r - 30;
    tachoCtx.beginPath();
    tachoCtx.arc(cx, cy, rTurbo, startAngle, endAngle);
    tachoCtx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    tachoCtx.lineWidth = 4;
    tachoCtx.stroke();

    if (state.turboBoost > 0.03) {
      const turboAngle = startAngle + state.turboBoost * totalSweep;
      tachoCtx.beginPath();
      tachoCtx.arc(cx, cy, rTurbo, startAngle, turboAngle);
      tachoCtx.strokeStyle = state.turboBoost >= 0.82 ? '#ef4444' : '#f59e0b';
      tachoCtx.lineWidth = 4.5;
      tachoCtx.lineCap = 'round';
      tachoCtx.stroke();
    }
  }
}

const hudDom = {
  speedValue: document.getElementById('speed-value'),
  rpmReadout: document.getElementById('rpm-readout'),
  gearDisplay: document.getElementById('gear-display'),
  redlineLamp: document.getElementById('redline-lamp'),
  barThrottle: document.getElementById('bar-throttle'),
  barBrake: document.getElementById('bar-brake'),
  barHandbrake: document.getElementById('bar-handbrake'),
  barTurbo: document.getElementById('bar-turbo'),
  turboPedalCol: document.getElementById('turbo-pedal-col'),
  turboBarVal: document.getElementById('turbo-bar-val'),
  suspBars: ['fl', 'fr', 'rl', 'rr'].map((id) => document.getElementById(`susp-${id}`)),
  slipDots: ['fl', 'fr', 'rl', 'rr'].map((id) => document.getElementById(`slip-${id}`)),
  banner: document.getElementById('status-banner'),
  mIgnitionTxt: document.getElementById('m-ignition-txt'),
  mBtnIgnition: document.getElementById('mbtn-ignition'),
  mLightsTxt: document.getElementById('m-lights-txt'),
  mBtnLights: document.getElementById('mbtn-lights'),
  mTransTxt: document.getElementById('m-trans-txt'),
  mGearCluster: document.getElementById('m-gear-cluster'),
  mSpawnTxt: document.getElementById('m-spawn-txt'),
  turboLabel: document.getElementById('turbo-label'),
  btnTurbo: document.getElementById('btn-turbo'),
  mTurboTxt: document.getElementById('m-turbo-txt'),
  mBtnTurbo: document.getElementById('mbtn-turbo'),
  todLabel: document.getElementById('tod-label'),
  btnTod: document.getElementById('btn-tod'),
  mTodTxt: document.getElementById('m-tod-txt'),
  mBtnTod: document.getElementById('mbtn-tod'),
  btnAbs: document.getElementById('btn-abs'),
  absLabel: document.getElementById('abs-label'),
  mBtnAbs: document.getElementById('mbtn-abs'),
  mAbsTxt: document.getElementById('m-abs-txt'),
  menuAbsLabel: document.getElementById('menu-abs-label'),
  menuAbsBtn: document.getElementById('menu-abs-btn'),
  btnTcs: document.getElementById('btn-tcs'),
  tcsLabel: document.getElementById('tcs-label'),
  mBtnTcs: document.getElementById('mbtn-tcs'),
  mTcsTxt: document.getElementById('m-tcs-txt'),
  menuTcsLabel: document.getElementById('menu-tcs-label'),
  menuTcsBtn: document.getElementById('menu-tcs-btn')
};

function updateHUD() {
  drawTachometer();

  if (hudDom.speedValue) hudDom.speedValue.textContent = Math.round(state.speedKmh);
  if (hudDom.rpmReadout) hudDom.rpmReadout.textContent = `${Math.round(state.rpm)} RPM`;

  const gearText = state.gear === -1 ? 'R' : state.gear === 0 ? 'N' : String(state.gear);
  if (hudDom.gearDisplay) {
    hudDom.gearDisplay.textContent = gearText;
    hudDom.gearDisplay.classList.toggle('redline', state.cuttingRev || state.rpm >= CORSA_SPECS.RedlineRPM);
  }

  if (hudDom.redlineLamp) {
    hudDom.redlineLamp.classList.toggle('active', state.cuttingRev || state.rpm >= CORSA_SPECS.RedlineRPM);
  }

  if (hudDom.barThrottle) hudDom.barThrottle.style.height = `${Math.round(state.throttleInput * 100)}%`;
  if (hudDom.barBrake) hudDom.barBrake.style.height = `${Math.round(state.brakeInput * 100)}%`;
  if (hudDom.barHandbrake) hudDom.barHandbrake.style.height = `${Math.round(state.handbrakeInput * 100)}%`;

  if (hudDom.barTurbo && hudDom.turboPedalCol) {
    if (state.turboInstalled) {
      hudDom.turboPedalCol.classList.remove('hud-hidden');
      const boostPct = Math.round(state.turboBoost * 100);
      hudDom.barTurbo.style.height = `${boostPct}%`;
      const isFull = state.turboBoost >= 0.82;
      hudDom.barTurbo.classList.toggle('full', isFull);
      hudDom.turboPedalCol.classList.toggle('full', isFull);
      if (hudDom.turboBarVal) {
        hudDom.turboBarVal.textContent = isFull ? '1.5b 🔥' : `${(state.turboBoost * 1.5).toFixed(1)}b`;
      }
    } else {
      hudDom.turboPedalCol.classList.add('hud-hidden');
    }
  }

  for (let idx = 0; idx < 4; idx++) {
    const suspBar = hudDom.suspBars[idx];
    const slipDot = hudDom.slipDots[idx];
    if (suspBar) suspBar.style.width = `${Math.round(state.wheelCompression[idx] * 100)}%`;
    if (slipDot) slipDot.classList.toggle('slipping', state.wheelSkids[idx] > 0.35);
  }

  const banner = hudDom.banner;
  if (banner) {
    if (state.cuttingRev) {
      const maxG = getGearMaxSpeedKmh(state.gear);
      banner.textContent =
        state.gear > 0 && state.gear < 5
          ? `LIMITE DA ${state.gear}ª MARCHA (${maxG} KM/H) — TROQUE DE MARCHA (+)`
          : 'CORTE DE GIRO ATIVO (6.500+ RPM)';
      banner.classList.remove('hud-hidden');
    } else if (state.handbrakeInput > 0.5 && state.speedKmh > 6) {
      banner.textContent = 'FREIO DE MÃO ACIONADO';
      banner.classList.remove('hud-hidden');
    } else {
      banner.classList.add('hud-hidden');
    }
  }

  // Atualiza estados dos botões touch para celular
  if (hudDom.mIgnitionTxt && hudDom.mBtnIgnition) {
    if (state.startingEngine) {
      hudDom.mIgnitionTxt.textContent = 'PARTIDA...';
      hudDom.mBtnIgnition.classList.remove('active');
    } else {
      hudDom.mIgnitionTxt.textContent = state.engineOn ? 'MOTOR: ON' : 'MOTOR: OFF';
      hudDom.mBtnIgnition.classList.toggle('active', state.engineOn);
    }
  }

  if (hudDom.mLightsTxt && hudDom.mBtnLights) {
    hudDom.mLightsTxt.textContent = state.headlightsOn ? 'FARÓIS: ON' : 'FARÓIS: OFF';
    hudDom.mBtnLights.classList.toggle('active', state.headlightsOn);
  }

  if (hudDom.mTransTxt) {
    hudDom.mTransTxt.textContent = state.transmission;
  }
  if (hudDom.mGearCluster) {
    hudDom.mGearCluster.style.display = state.transmission === 'MANUAL' ? 'flex' : 'none';
  }

  if (hudDom.mSpawnTxt) {
    hudDom.mSpawnTxt.textContent = `AV. ${state.spawnIdx + 1}`;
  }

  if (envTimeSystem && envTimeSystem.mode === 'auto') {
    envTimeSystem.updateHudDom();
  }

  // Atualiza botões e indicadores do Turbo
  if (hudDom.turboLabel && hudDom.btnTurbo) {
    if (!state.turboInstalled) {
      hudDom.turboLabel.textContent = 'OFF';
      hudDom.btnTurbo.classList.remove('turbo-on', 'turbo-full');
    } else if (state.turboBoost >= 0.82) {
      hudDom.turboLabel.textContent = 'CHEIO! 🔥 1.5b';
      hudDom.btnTurbo.classList.add('turbo-on', 'turbo-full');
    } else if (state.turboBoost > 0.08) {
      hudDom.turboLabel.textContent = `${(state.turboBoost * 1.5).toFixed(1)} BAR`;
      hudDom.btnTurbo.classList.add('turbo-on');
      hudDom.btnTurbo.classList.remove('turbo-full');
    } else {
      hudDom.turboLabel.textContent = 'ON (0.0b)';
      hudDom.btnTurbo.classList.add('turbo-on');
      hudDom.btnTurbo.classList.remove('turbo-full');
    }
  }
  if (hudDom.mTurboTxt && hudDom.mBtnTurbo) {
    if (!state.turboInstalled) {
      hudDom.mTurboTxt.textContent = 'TURBO: OFF';
      hudDom.mBtnTurbo.classList.remove('active', 'turbo-full');
    } else if (state.turboBoost >= 0.82) {
      hudDom.mTurboTxt.textContent = 'TURBO: CHEIO 🔥';
      hudDom.mBtnTurbo.classList.add('active', 'turbo-full');
    } else if (state.turboBoost > 0.08) {
      hudDom.mTurboTxt.textContent = `TURBO: ${(state.turboBoost * 1.5).toFixed(1)}b`;
      hudDom.mBtnTurbo.classList.add('active');
      hudDom.mBtnTurbo.classList.remove('turbo-full');
    } else {
      hudDom.mTurboTxt.textContent = 'TURBO: ON';
      hudDom.mBtnTurbo.classList.add('active');
      hudDom.mBtnTurbo.classList.remove('turbo-full');
    }
  }

  // Indicação luminosa em tempo real de atuação do ABS e Controle de Tração (TCS)
  if (hudDom.btnAbs) hudDom.btnAbs.classList.toggle('assist-intervening', state.absActive);
  if (hudDom.mBtnAbs) hudDom.mBtnAbs.classList.toggle('assist-intervening', state.absActive);
  if (hudDom.btnTcs) hudDom.btnTcs.classList.toggle('assist-intervening', state.tcsActive);
  if (hudDom.mBtnTcs) hudDom.mBtnTcs.classList.toggle('assist-intervening', state.tcsActive);
}

// ============================================================================
// 11. CONTROLES DE TECLADO (W, A, S, D, ESPAÇO, +, -, M, L, I, C, R) E BOTÕES HUD
// ============================================================================
function changeGear(newGear) {
  const clamped = THREE.MathUtils.clamp(newGear, -1, 5);
  if (clamped !== state.gear) {
    const prevGear = state.gear;
    state.gear = clamped;
    state.shiftDuration = prevGear !== 0 && clamped !== 0 ? 0.22 : 0.14;
    state.shiftCooldown = state.shiftDuration;
    state.clutchEngagement = 0.05;

    // Simulação de inércia de embreagem (upshift) e Rev-Match automático (downshift)
    if (prevGear !== 0 && clamped !== 0 && state.engineOn) {
      const nextMax = getGearMaxSpeedKmh(clamped);
      const nextRatio = nextMax > 0 ? state.speedKmh / nextMax : 0;
      const targetNextRPM = CORSA_SPECS.IdleRPM + nextRatio * (CORSA_SPECS.RedlineRPM - CORSA_SPECS.IdleRPM);

      if (clamped < prevGear && state.speedKmh > 6) {
        state.shiftPhase = 'downshift';
        state.revMatchTargetRPM = THREE.MathUtils.clamp(targetNextRPM * 1.07, CORSA_SPECS.IdleRPM + 300, CORSA_SPECS.RedlineRPM - 150);
      } else if (clamped > prevGear) {
        state.shiftPhase = 'upshift';
      } else {
        state.shiftPhase = 'none';
      }
    } else {
      state.shiftPhase = 'none';
    }

    // A válvula de alívio SÓ espirra nas trocas de marcha se o turbo estiver cheio (pressão acumulada >= 0.65)!
    if (state.turboInstalled && state.engineOn && state.turboBoost >= 0.65) {
      triggerTurboBlowOff();
    }
  }
}

function toggleTransmissionMode() {
  state.transmission = state.transmission === 'MANUAL' ? 'AUTO' : 'MANUAL';
  const transLabel = document.getElementById('trans-label');
  const menuTransLabel = document.getElementById('menu-trans-label');
  const text = state.transmission === 'MANUAL' ? 'MANUAL' : 'AUTOMÁTICO';
  if (transLabel) transLabel.textContent = text;
  if (menuTransLabel) menuTransLabel.textContent = text;
}

function toggleHeadlights() {
  state.headlightsOn = !state.headlightsOn;
  const btn = document.getElementById('btn-lights');
  const label = document.getElementById('lights-label');
  const menuLabel = document.getElementById('menu-lights-label');
  if (label) label.textContent = state.headlightsOn ? 'ON' : 'OFF';
  if (menuLabel) menuLabel.textContent = state.headlightsOn ? 'ON' : 'OFF';
  if (btn) btn.classList.toggle('lights-on', state.headlightsOn);
}

function toggleEngineIgnition() {
  if (state.startingEngine) return;
  const btn = document.getElementById('btn-ignition');
  const label = document.getElementById('engine-label');

  if (!state.engineOn) {
    state.startingEngine = true;
    if (label) label.textContent = 'PARTIDA...';
    carAudio.triggerIgnition(() => {
      state.engineOn = true;
      state.startingEngine = false;
      state.rpm = CORSA_SPECS.IdleRPM;
      if (btn) {
        btn.classList.remove('engine-off');
        btn.classList.add('engine-on');
      }
      if (label) label.textContent = 'LIGADO';
    });
  } else {
    state.engineOn = false;
    state.rpm = 0;
    carAudio.shutDownEngine();
    if (btn) {
      btn.classList.remove('engine-on');
      btn.classList.add('engine-off');
    }
    if (label) label.textContent = 'DESLIGADO';
  }
}

function setTurboInstalled(enabled) {
  state.turboInstalled = enabled;
  if (!enabled) {
    state.turboBoost = 0.0;
  }
  const toggleBtn = document.getElementById('turbo-toggle-btn');
  const badge = document.getElementById('turbo-badge');
  const hudBtn = document.getElementById('btn-turbo');
  const hudLabel = document.getElementById('turbo-label');
  const mBtn = document.getElementById('mbtn-turbo');
  const mTxt = document.getElementById('m-turbo-txt');

  if (toggleBtn) {
    toggleBtn.classList.toggle('is-active', enabled);
  }
  if (badge) {
    badge.textContent = enabled ? 'TURBO: INSTALADO 🐌' : 'TURBO: DESATIVADO';
    badge.classList.toggle('active', enabled);
  }
  if (hudLabel) hudLabel.textContent = enabled ? 'ON 🐌' : 'OFF';
  if (hudBtn) hudBtn.classList.toggle('turbo-on', enabled);

  if (mTxt) mTxt.textContent = enabled ? 'TURBO: ON' : 'TURBO: OFF';
  if (mBtn) mBtn.classList.toggle('active', enabled);
}

function saveAssistSettings() {
  try {
    localStorage.setItem('corsa3d_assists', JSON.stringify({ abs: state.absEnabled, tcs: state.tcsEnabled }));
  } catch (e) {}
}

function updateAssistButtonsUI() {
  if (hudDom.absLabel) hudDom.absLabel.textContent = state.absEnabled ? 'ON' : 'OFF';
  if (hudDom.btnAbs) hudDom.btnAbs.classList.toggle('assist-on', state.absEnabled);
  if (hudDom.mAbsTxt) hudDom.mAbsTxt.textContent = state.absEnabled ? 'ABS: ON' : 'ABS: OFF';
  if (hudDom.mBtnAbs) hudDom.mBtnAbs.classList.toggle('active', state.absEnabled);
  if (hudDom.menuAbsLabel) hudDom.menuAbsLabel.textContent = state.absEnabled ? 'ON' : 'OFF';
  if (hudDom.menuAbsBtn) hudDom.menuAbsBtn.classList.toggle('is-active', state.absEnabled);

  if (hudDom.tcsLabel) hudDom.tcsLabel.textContent = state.tcsEnabled ? 'ON' : 'OFF';
  if (hudDom.btnTcs) hudDom.btnTcs.classList.toggle('assist-on', state.tcsEnabled);
  if (hudDom.mTcsTxt) hudDom.mTcsTxt.textContent = state.tcsEnabled ? 'TCS: ON' : 'TCS: OFF';
  if (hudDom.mBtnTcs) hudDom.mBtnTcs.classList.toggle('active', state.tcsEnabled);
  if (hudDom.menuTcsLabel) hudDom.menuTcsLabel.textContent = state.tcsEnabled ? 'ON' : 'OFF';
  if (hudDom.menuTcsBtn) hudDom.menuTcsBtn.classList.toggle('is-active', state.tcsEnabled);
}

function toggleABS() {
  state.absEnabled = !state.absEnabled;
  if (!state.absEnabled) state.absActive = false;
  saveAssistSettings();
  updateAssistButtonsUI();
}

function toggleTCS() {
  state.tcsEnabled = !state.tcsEnabled;
  if (!state.tcsEnabled) state.tcsActive = false;
  saveAssistSettings();
  updateAssistButtonsUI();
}

function cycleCameraMode() {
  state.cameraMode = (state.cameraMode + 1) % 4;
  state.orbitYaw = state.cameraMode === 3 ? Math.PI * 0.35 : 0;
  state.orbitPitch = 0.18;
  const label = document.getElementById('cam-label');
  const menuCamLabel = document.getElementById('menu-camera-label');
  if (label) label.textContent = CAMERA_MODE_NAMES[state.cameraMode];
  if (menuCamLabel) menuCamLabel.textContent = CAMERA_MODE_NAMES[state.cameraMode];
}

function isActionCodeMatch(e, action) {
  const bound = state.keybinds[action];
  if (e.code === bound) return true;
  if (action === 'accelerate' && e.code === 'ArrowUp') return true;
  if (action === 'brake' && e.code === 'ArrowDown') return true;
  if (action === 'steerLeft' && e.code === 'ArrowLeft') return true;
  if (action === 'steerRight' && e.code === 'ArrowRight') return true;
  if (action === 'gearUp' && e.code === 'NumpadAdd') return true;
  if (action === 'gearDown' && e.code === 'NumpadSubtract') return true;
  return false;
}

window.addEventListener('keydown', (e) => {
  // Modo de captura de nova tecla no menu Opções -> Atribuir Teclas
  if (state.listeningAction) {
    e.preventDefault();
    e.stopPropagation();
    const action = state.listeningAction;
    state.listeningAction = null;
    if (e.code !== 'Escape') {
      state.keybinds[action] = e.code;
      try {
        localStorage.setItem('corsa3d_keybinds', JSON.stringify(state.keybinds));
      } catch (err) {}
    }
    renderKeybindsUI();
    return;
  }

  if (e.code === 'Escape' && !e.repeat) {
    if (state.started) {
      if (state.menuOpen) {
        closeGameMenu();
      } else {
        openGameMenu('menu-home');
      }
    } else if (state.menuOpen) {
      switchMenuView('menu-home');
    }
    return;
  }

  if (state.menuOpen || !state.started) {
    if (e.code === state.keybinds.timeOfDay && !e.repeat) cycleTimeOfDay();
    return;
  }

  if (isActionCodeMatch(e, 'accelerate')) keys.w = true;
  if (isActionCodeMatch(e, 'brake')) keys.s = true;
  if (isActionCodeMatch(e, 'steerLeft')) keys.a = true;
  if (isActionCodeMatch(e, 'steerRight')) keys.d = true;
  if (isActionCodeMatch(e, 'handbrake')) {
    keys.space = true;
    e.preventDefault();
  }

  if (!e.repeat) {
    if (isActionCodeMatch(e, 'gearUp')) {
      changeGear(state.gear + 1);
    } else if (isActionCodeMatch(e, 'gearDown')) {
      changeGear(state.gear - 1);
    } else if (isActionCodeMatch(e, 'transmission')) {
      toggleTransmissionMode();
    } else if (isActionCodeMatch(e, 'turbo')) {
      setTurboInstalled(!state.turboInstalled);
    } else if (isActionCodeMatch(e, 'absToggle')) {
      toggleABS();
    } else if (isActionCodeMatch(e, 'tcsToggle')) {
      toggleTCS();
    } else if (isActionCodeMatch(e, 'headlights')) {
      toggleHeadlights();
    } else if (isActionCodeMatch(e, 'timeOfDay')) {
      cycleTimeOfDay();
    } else if (e.code === 'KeyG') {
      toggleGraphicsModal();
    } else if (isActionCodeMatch(e, 'ignition')) {
      toggleEngineIgnition();
    } else if (isActionCodeMatch(e, 'camera')) {
      cycleCameraMode();
    } else if (isActionCodeMatch(e, 'reset')) {
      resetCarToSpawn(state.spawnIdx);
    }
  }
});

// Evita teclas/pedais "presos" quando a janela perde o foco (Alt+Tab, notificação, troca de aba)
function releaseAllInputs() {
  keys.w = keys.s = keys.a = keys.d = keys.space = false;
  state.touchInput.throttle = 0;
  state.touchInput.brake = 0;
  state.touchInput.handbrake = 0;
  state.touchInput.steer = 0;
  state.isPointerDown = false;
  document.querySelectorAll('.pressed').forEach((el) => el.classList.remove('pressed'));
}
window.addEventListener('blur', releaseAllInputs);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseAllInputs();
    if (carAudio.ctx && carAudio.ctx.state === 'running') carAudio.ctx.suspend();
  } else if (state.started && carAudio.ctx && carAudio.ctx.state === 'suspended') {
    carAudio.ctx.resume();
  }
});

window.addEventListener('keyup', (e) => {
  if (isActionCodeMatch(e, 'accelerate')) keys.w = false;
  if (isActionCodeMatch(e, 'brake')) keys.s = false;
  if (isActionCodeMatch(e, 'steerLeft')) keys.a = false;
  if (isActionCodeMatch(e, 'steerRight')) keys.d = false;
  if (isActionCodeMatch(e, 'handbrake')) keys.space = false;
});

renderer.domElement.addEventListener('pointerdown', () => {
  state.isPointerDown = true;
});
window.addEventListener('pointerup', () => {
  state.isPointerDown = false;
});
window.addEventListener('pointermove', (e) => {
  if (!state.isPointerDown) return;
  state.orbitYaw -= e.movementX * 0.0065;
  state.orbitPitch = THREE.MathUtils.clamp(state.orbitPitch + e.movementY * 0.0045, -0.15, 0.75);
});

// ============================================================================
// 12. CONTROLES PARA CELULAR (JOYSTICK ANALÓGICO, PEDAIS E AÇÕES TOUCH)
// ============================================================================
function setMobileMode(enabled) {
  state.mobileMode = enabled;
  const toggleBtn = document.getElementById('mobile-toggle-btn');
  const badge = document.getElementById('mobile-badge');
  const touchHudLabel = document.getElementById('touch-hud-label');
  const btnToggleTouch = document.getElementById('btn-toggle-touch');
  const mobileControls = document.getElementById('mobile-controls');
  const topHud = document.getElementById('top-hud');
  const controlsHelper = document.getElementById('controls-helper');

  if (toggleBtn) {
    toggleBtn.classList.toggle('is-active', enabled);
  }
  if (badge) {
    badge.textContent = enabled ? 'TOQUE: ATIVADO ✅' : 'TOQUE: DESATIVADO';
    badge.classList.toggle('active', enabled);
  }
  if (touchHudLabel) {
    touchHudLabel.textContent = enabled ? 'ON' : 'OFF';
  }
  if (btnToggleTouch) {
    btnToggleTouch.classList.toggle('active-mode', enabled);
  }

  if (enabled) {
    document.body.classList.add('mobile-active');
  } else {
    document.body.classList.remove('mobile-active');
  }

  if (state.started && !state.menuOpen) {
    if (enabled) {
      mobileControls?.classList.remove('hud-hidden');
      topHud?.classList.add('hud-hidden');
      controlsHelper?.classList.add('hud-hidden');
    } else {
      mobileControls?.classList.add('hud-hidden');
      topHud?.classList.remove('hud-hidden');
      controlsHelper?.classList.remove('hud-hidden');
    }
  }
}

function setupMobileControls() {
  const mobileToggleBtn = document.getElementById('mobile-toggle-btn');
  if (mobileToggleBtn) {
    mobileToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMobileMode(!state.mobileMode);
    });
  }

  const btnToggleTouch = document.getElementById('btn-toggle-touch');
  if (btnToggleTouch) {
    btnToggleTouch.addEventListener('click', (e) => {
      e.stopPropagation();
      setMobileMode(!state.mobileMode);
    });
  }

  // --- JOYSTICK ANALÓGICO VIRTUAL (VOLANTE PROGRESSIVO) ---
  const joystickZone = document.getElementById('virtual-joystick-zone');
  const joystickBase = document.getElementById('joystick-base');
  const joystickStick = document.getElementById('joystick-stick');
  let joystickTouchId = null;
  let joystickCenter = { x: 0, y: 0 };
  const joystickMaxRadius = 45;

  function updateJoystickPosition(touchX, touchY) {
    let dx = touchX - joystickCenter.x;
    let dy = touchY - joystickCenter.y;
    const dist = Math.hypot(dx, dy);

    if (dist > joystickMaxRadius) {
      const angle = Math.atan2(dy, dx);
      dx = Math.cos(angle) * joystickMaxRadius;
      dy = Math.sin(angle) * joystickMaxRadius;
    }

    if (joystickStick) {
      joystickStick.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    // Normalização de esterço:
    // dx < 0 (esquerda) => esterço positivo (virar para a esquerda)
    // dx > 0 (direita)  => esterço negativo (virar para a direita)
    state.touchInput.steer = -(dx / joystickMaxRadius);
  }

  function resetJoystick() {
    joystickTouchId = null;
    state.touchInput.steer = 0;
    if (joystickStick) {
      joystickStick.style.transform = 'translate(0px, 0px)';
    }
  }

  if (joystickZone && joystickBase) {
    joystickZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (joystickTouchId !== null) return;
      const touch = e.changedTouches[0];
      joystickTouchId = touch.identifier;
      const rect = joystickBase.getBoundingClientRect();
      joystickCenter = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      updateJoystickPosition(touch.clientX, touch.clientY);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (joystickTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === joystickTouchId) {
          e.preventDefault();
          updateJoystickPosition(touch.clientX, touch.clientY);
          break;
        }
      }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      if (joystickTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === joystickTouchId) {
          e.preventDefault();
          resetJoystick();
          break;
        }
      }
    });

    window.addEventListener('touchcancel', (e) => {
      if (joystickTouchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === joystickTouchId) {
          resetJoystick();
          break;
        }
      }
    });

    // Suporte também a arrasto com Mouse no PC (para testar o volante no computador)
    let isMouseDraggingJoystick = false;
    joystickZone.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isMouseDraggingJoystick = true;
      const rect = joystickBase.getBoundingClientRect();
      joystickCenter = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      updateJoystickPosition(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
      if (!isMouseDraggingJoystick) return;
      updateJoystickPosition(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => {
      if (isMouseDraggingJoystick) {
        isMouseDraggingJoystick = false;
        resetJoystick();
      }
    });
  }

  // --- BOTÕES DE PEDAIS (ACELERADOR, FREIO, FREIO DE MÃO / DRIFT) ---
  function bindHoldButton(elem, onDown, onUp) {
    if (!elem) return;
    const start = (e) => {
      e.preventDefault();
      e.stopPropagation();
      elem.classList.add('pressed');
      onDown();
    };
    const end = (e) => {
      e.preventDefault();
      e.stopPropagation();
      elem.classList.remove('pressed');
      onUp();
    };

    elem.addEventListener('touchstart', start, { passive: false });
    elem.addEventListener('touchend', end, { passive: false });
    elem.addEventListener('touchcancel', end, { passive: false });

    elem.addEventListener('mousedown', start);
    elem.addEventListener('mouseup', end);
    elem.addEventListener('mouseleave', end);
  }

  const btnThrottle = document.getElementById('mbtn-throttle');
  bindHoldButton(btnThrottle, () => {
    state.touchInput.throttle = 1.0;
  }, () => {
    state.touchInput.throttle = 0.0;
  });

  const btnBrake = document.getElementById('mbtn-brake');
  bindHoldButton(btnBrake, () => {
    state.touchInput.brake = 1.0;
  }, () => {
    state.touchInput.brake = 0.0;
  });

  const btnHandbrake = document.getElementById('mbtn-handbrake');
  bindHoldButton(btnHandbrake, () => {
    state.touchInput.handbrake = 1.0;
  }, () => {
    state.touchInput.handbrake = 0.0;
  });

  // --- BOTÕES DE AÇÃO RÁPIDA (IGNIÇÃO, LUZES, CÂMBIO, CÂMERA, RESET) ---
  document.getElementById('mbtn-ignition')?.addEventListener('click', (e) => {
    e.preventDefault();
    toggleEngineIgnition();
  });

  document.getElementById('mbtn-lights')?.addEventListener('click', (e) => {
    e.preventDefault();
    toggleHeadlights();
  });

  document.getElementById('mbtn-tod')?.addEventListener('click', (e) => {
    e.preventDefault();
    cycleTimeOfDay();
  });

  document.getElementById('mbtn-transmission')?.addEventListener('click', (e) => {
    e.preventDefault();
    toggleTransmissionMode();
  });

  document.getElementById('mbtn-gear-up')?.addEventListener('click', (e) => {
    e.preventDefault();
    changeGear(state.gear + 1);
  });

  document.getElementById('mbtn-gear-down')?.addEventListener('click', (e) => {
    e.preventDefault();
    changeGear(state.gear - 1);
  });

  document.getElementById('mbtn-spawn')?.addEventListener('click', (e) => {
    e.preventDefault();
    resetCarToSpawn(state.spawnIdx + 1);
  });

  document.getElementById('mbtn-camera')?.addEventListener('click', (e) => {
    e.preventDefault();
    cycleCameraMode();
  });

  document.getElementById('mbtn-reset')?.addEventListener('click', (e) => {
    e.preventDefault();
    resetCarToSpawn(state.spawnIdx);
  });

  document.getElementById('mbtn-switch-pc')?.addEventListener('click', (e) => {
    e.preventDefault();
    setMobileMode(false);
  });

  // Auto-detecção inteligente de tela de toque (se for celular/tablet, pré-ativa de início)
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (window.innerWidth <= 820);
  if (isTouchDevice) {
    setMobileMode(true);
  } else {
    setMobileMode(false);
  }
}

function setupTurboControls() {
  document.getElementById('turbo-toggle-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setTurboInstalled(!state.turboInstalled);
  });

  document.getElementById('btn-turbo')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setTurboInstalled(!state.turboInstalled);
  });

  document.getElementById('mbtn-turbo')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setTurboInstalled(!state.turboInstalled);
  });
}

function switchMenuView(viewId, tabId = null) {
  document.querySelectorAll('.menu-view').forEach((v) => {
    v.classList.toggle('active', v.id === viewId);
  });
  if (tabId && viewId === 'panel-options') {
    document.querySelectorAll('.opt-tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.opt-tab-content').forEach((tab) => {
      tab.classList.toggle('active', tab.id === tabId);
    });
  }
}

function openGameMenu(viewId = 'menu-home', tabId = null) {
  state.menuOpen = true;
  state.listeningAction = null;
  releaseAllInputs();
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.remove('hud-hidden');
  document.getElementById('dashboard-hud')?.classList.add('hud-hidden');
  document.getElementById('minimap-container')?.classList.add('hud-hidden');
  document.getElementById('mobile-controls')?.classList.add('hud-hidden');

  if (state.started) {
    const startSpan = startBtn?.querySelector('span');
    if (startSpan) startSpan.textContent = '▶ CONTINUAR JOGO';
    document.getElementById('btn-pause-reset')?.classList.remove('hud-hidden');
  }
  switchMenuView(viewId, tabId);
}

function closeGameMenu() {
  if (!state.loaded) return;
  state.menuOpen = false;
  state.listeningAction = null;
  document.getElementById('loading-overlay')?.classList.add('hud-hidden');
  document.getElementById('dashboard-hud')?.classList.remove('hud-hidden');
  document.getElementById('minimap-container')?.classList.remove('hud-hidden');
  setMobileMode(state.mobileMode);
}

function applyAudioSettings() {
  try {
    localStorage.setItem('corsa3d_audio', JSON.stringify(state.audio));
  } catch (e) {}

  const pairs = [
    ['vol-master', 'vol-master-val', state.audio.master],
    ['vol-engine', 'vol-engine-val', state.audio.engine],
    ['vol-turbo', 'vol-turbo-val', state.audio.turbo],
    ['vol-tires', 'vol-tires-val', state.audio.tires]
  ];
  pairs.forEach(([inputId, valId, frac]) => {
    const inp = document.getElementById(inputId);
    const lbl = document.getElementById(valId);
    const pct = Math.round(frac * 100);
    if (inp) inp.value = String(pct);
    if (lbl) lbl.textContent = `${pct}%`;
  });
}

function renderKeybindsUI() {
  const list = document.getElementById('keybinds-list');
  if (!list) return;
  list.innerHTML = '';

  KEYBIND_LABELS.forEach(({ action, label }) => {
    const row = document.createElement('div');
    row.className = 'keybind-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'keybind-name';
    nameEl.textContent = label;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'keybind-btn';
    if (state.listeningAction === action) {
      btn.classList.add('listening');
      btn.textContent = 'PRESSIONE...';
    } else {
      btn.textContent = formatKeyCode(state.keybinds[action]);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.listeningAction = state.listeningAction === action ? null : action;
      renderKeybindsUI();
    });

    row.appendChild(nameEl);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function setupGameMenuAndOptions() {
  document.getElementById('btn-open-options')?.addEventListener('click', () => switchMenuView('panel-options', 'tab-audio'));
  document.getElementById('btn-open-maps')?.addEventListener('click', () => switchMenuView('panel-maps'));
  document.getElementById('btn-open-cars')?.addEventListener('click', () => switchMenuView('panel-cars'));

  document.querySelectorAll('.back-menu-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.listeningAction = null;
      switchMenuView(btn.dataset.back || 'menu-home');
    });
  });

  document.querySelectorAll('.opt-tab-btn').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      state.listeningAction = null;
      switchMenuView('panel-options', tabBtn.dataset.tab);
    });
  });

  // Pause & Opções direto do HUD (PC e Mobile)
  document.getElementById('btn-options-hud')?.addEventListener('click', () => openGameMenu('panel-options', 'tab-audio'));
  document.getElementById('mbtn-options')?.addEventListener('click', (e) => {
    e.preventDefault();
    openGameMenu('panel-options', 'tab-audio');
  });

  document.getElementById('btn-pause-reset')?.addEventListener('click', () => {
    resetCarToSpawn(state.spawnIdx);
    closeGameMenu();
  });

  // Seletor de Ponto de Partida em San Francisco
  document.querySelectorAll('.spawn-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const idx = Number(chip.dataset.spawn) || 0;
      resetCarToSpawn(idx);
    });
  });

  // Ações rápidas dentro do Menu
  document.getElementById('menu-tod-btn')?.addEventListener('click', cycleTimeOfDay);
  document.getElementById('menu-trans-btn')?.addEventListener('click', toggleTransmissionMode);
  document.getElementById('menu-lights-btn')?.addEventListener('click', toggleHeadlights);
  document.getElementById('menu-camera-btn')?.addEventListener('click', cycleCameraMode);
  document.getElementById('menu-abs-btn')?.addEventListener('click', toggleABS);
  document.getElementById('menu-tcs-btn')?.addEventListener('click', toggleTCS);
  document.getElementById('btn-abs')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleABS();
  });
  document.getElementById('btn-tcs')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTCS();
  });
  document.getElementById('mbtn-abs')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleABS();
  });
  document.getElementById('mbtn-tcs')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTCS();
  });

  // Sliders de Volume
  const sliderMap = [
    ['vol-master', 'master'],
    ['vol-engine', 'engine'],
    ['vol-turbo', 'turbo'],
    ['vol-tires', 'tires']
  ];
  sliderMap.forEach(([id, key]) => {
    document.getElementById(id)?.addEventListener('input', (e) => {
      state.audio[key] = Number(e.target.value) / 100;
      applyAudioSettings();
    });
  });

  document.getElementById('btn-reset-audio')?.addEventListener('click', () => {
    state.audio = { ...AUDIO_DEFAULTS };
    applyAudioSettings();
  });

  document.getElementById('btn-reset-keys')?.addEventListener('click', () => {
    state.keybinds = { ...DEFAULT_KEYBINDS };
    state.listeningAction = null;
    try {
      localStorage.setItem('corsa3d_keybinds', JSON.stringify(state.keybinds));
    } catch (err) {}
    renderKeybindsUI();
  });

  document.querySelectorAll('.gfx-preset-card').forEach((card) => {
    card.addEventListener('click', () => {
      const q = card.dataset.quality;
      if (q) applyGraphicsQuality(q);
    });
  });

  const versionBadge = document.getElementById('game-version-badge');
  if (versionBadge) versionBadge.textContent = `v${GAME_VERSION}`;

  applyAudioSettings();
  renderKeybindsUI();
  updateAssistButtonsUI();
  applyGraphicsQuality(state.graphicsQuality);
  if (envTimeSystem) envTimeSystem.updateHudDom();
}

startBtn.addEventListener('click', () => {
  if (!state.loaded) return;

  if (!state.started) {
    state.started = true;
    closeGameMenu();
    setTurboInstalled(state.turboInstalled);
    carAudio.startContinuousLoops();
    toggleEngineIgnition();
  } else {
    closeGameMenu();
  }
});

document.getElementById('btn-tod')?.addEventListener('click', cycleTimeOfDay);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// 13. LOOP DE SIMULAÇÃO EM TEMPO REAL (60 FPS CRAVADOS E FLUIDOS)
// ============================================================================
let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;

  if (state.loaded) {
    world.step(1 / 60, dt, 3);
    if (chassisBody && chassisBody.position.y < 12.0) {
      resetCarToSpawn(state.spawnIdx);
    }
    updateVehiclePhysicsAndEffects(dt);
    syncVisualMeshes();
    if (envTimeSystem) {
      envTimeSystem.update(dt, corsaChassisVisual ? corsaChassisVisual.position : camera.position);
    }
    updateCamera(dt);
    smokeSystem.update(dt, camera);
    carAudio.update(dt);
    if (state.started && !state.menuOpen) {
      updateHUD();
      if (minimapRenderer && chassisBody) {
        minimapRenderer.render(chassisBody.position, chassisBody.quaternion, state.speedKmh);
      }
    }
  }

  renderer.render(scene, camera);
}

initSimulation();
setupMobileControls();
setupTurboControls();
setupGameMenuAndOptions();
requestAnimationFrame(animate);
