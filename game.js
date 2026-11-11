import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as CANNON from 'cannon-es';

// ============================================================================
// 1. CONFIGURAÇÃO DE ESCALA REALISTA E PARÂMETROS DO OPEL CORSA B 1998 (FWD)
// ============================================================================
const CITY_SCALE = 22.0;        // Escala da cidade ajustada para pistas largas e pontes na altura real
const CAR_SCALE = 0.62;         // Escala proporcional do Corsa ao mapa (passa livremente sob pontes e viadutos!)

// Fator de escala da velocidade física no mundo para ritmo 100% natural (elimina o efeito 1.5x acelerado!)
const WORLD_SPEED_SCALE = 0.40;

// Grupos de colisão (bitmasks) para isolar carroceria do asfalto (sem pulinhos)
const COLLISION_GROUND = 1;
const COLLISION_CHASSIS = 2;
const COLLISION_WALLS = 4;

// Pontos de Spawn verificados diretamente sobre o asfalto livre de obstáculos
const SPAWN_POINTS = [
  {
    name: 'AVENIDA 1 (PRINCIPAL)',
    pos: new THREE.Vector3(5.976 * CITY_SCALE, -0.42, -1.86 * CITY_SCALE),
    yaw: 0 // Olhando para -Z (avenida principal aberta em direção à ponte)
  },
  {
    name: 'AVENIDA 2 (LESTE)',
    pos: new THREE.Vector3(10.626 * CITY_SCALE, 0.15, -7.66 * CITY_SCALE),
    yaw: 0
  },
  {
    name: 'AVENIDA CENTRAL',
    pos: new THREE.Vector3(5.986 * CITY_SCALE, -0.05, -5.66 * CITY_SCALE),
    yaw: 0
  }
];

const CORSA_SPECS = {
  mass: 480,                              // Massa equilibrada para escala 0.62
  wheelRadius: 0.2854 * CAR_SCALE,        // metros (~0.177m)
  IdleRPM: 850,
  MaxRPM: 6800,
  RedlineRPM: 6500,
  ShiftUpRPM: 6150,
  ShiftDownRPM: 2700,
  // Limites reais de velocidade máxima no velocímetro por marcha (no corte de giro a 6500 RPM):
  // 1ª: 20 km/h | 2ª: 50 km/h | 3ª: 90 km/h | 4ª: 120 km/h | 5ª: 180 km/h | Ré: 28 km/h
  gearMaxSpeedKmh: {
    '-1': 28,
    '0': 0,
    '1': 20,
    '2': 50,
    '3': 90,
    '4': 120,
    '5': 180
  },
  // Força de tração calibrada para ritmo real (aceleração progressiva e suave, sem disparar feito míssil)
  gearDriveForces: {
    '-1': -760,
    '0': 0,
    '1': 840,
    '2': 710,
    '3': 590,
    '4': 510,
    '5': 440
  },
  maxSteerAngle: 0.50,                    // ~28.5 graus em baixa velocidade
  // Suspensão MacPherson ultra-estável
  suspensionStiffness: 32.0,
  suspensionRestLength: 0.34 * CAR_SCALE,
  maxSuspensionTravel: 0.22 * CAR_SCALE,
  dampingCompression: 4.8,
  dampingRelaxation: 5.6,
  rollInfluence: 0.12,                    // Permite inclinação visual natural da carroceria nas curvas e drifts
  frictionSlipNormal: 3.2,                // Aderência firme de pneu de borracha no asfalto seco
  frictionSlipHandbrake: 1.85             // Pneu traseiro perde aderência lateral com atrito cinético de borracha no asfalto (DRIFT CONTROLÁVEL!)
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
const state = {
  loaded: false,
  started: false,
  engineOn: false,
  startingEngine: false,
  headlightsOn: false,    // Faróis dianteiros e lanternas traseiras (Tecla L ou botão HUD)
  transmission: 'MANUAL', // 'MANUAL' ou 'AUTO'
  gear: 1,                // -1 = R, 0 = N, 1..5 = 1ª a 5ª marcha
  shiftCooldown: 0,
  rpm: 0,
  speedKmh: 0,
  forwardSpeedMs: 0,
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
      { key: 'skid', url: './Carro derrapando.mp3' }
    ];

    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      this.rawBuffers[item.key] = await new Promise((resolve, reject) => {
        audioLoader.load(item.url, resolve, undefined, reject);
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
  }

  startContinuousLoops() {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.startSlicedLoop(this.sources.engineIdle, this.slicedBuffers.idle);
    this.startSlicedLoop(this.sources.engineLoad, this.slicedBuffers.midLoad);
    this.startSlicedLoop(this.sources.exhaustLoad, this.slicedBuffers.highLoad);
    this.startSlicedLoop(this.sources.revCutExhaust, this.slicedBuffers.revCut);
    this.startSlicedLoop(this.sources.revCutEngine, this.slicedBuffers.revCut);
    this.startSlicedLoop(this.sources.skid, this.slicedBuffers.skid);
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
    starter.setVolume(0.85);
    starter.setPlaybackRate(1.0);
    starter.offset = 0.05;
    starter.play();

    setTimeout(() => {
      if (onComplete) onComplete();
    }, 1050);
  }

  shutDownEngine() {
    const now = this.ctx.currentTime;
    ['engineIdle', 'engineLoad', 'exhaustLoad', 'revCutExhaust', 'revCutEngine'].forEach((k) => {
      const s = this.sources[k];
      if (s && s.gain) {
        s.gain.gain.setTargetAtTime(0.0, now, 0.08);
      }
    });
  }

  update() {
    if (!this.sources.engineIdle || !this.sources.engineIdle.isPlaying) return;
    const now = this.ctx.currentTime;

    const skidVol = THREE.MathUtils.clamp(state.skidIntensity * 0.72, 0, 0.80);
    const skidPitch = THREE.MathUtils.clamp(0.90 + state.skidIntensity * 0.20 + (state.speedKmh / 220) * 0.12, 0.85, 1.28);
    this.sources.skid.gain.gain.setTargetAtTime(skidVol, now, 0.04);
    if (this.sources.skid.source) {
      this.sources.skid.source.playbackRate.setTargetAtTime(skidPitch, now, 0.05);
    }

    if (!state.engineOn) {
      this.shutDownEngine();
      return;
    }

    const rpmNorm = THREE.MathUtils.clamp((state.rpm - CORSA_SPECS.IdleRPM) / (CORSA_SPECS.MaxRPM - CORSA_SPECS.IdleRPM), 0, 1);
    const throttle = state.throttleInput;

    const idlePitch = 0.96 + rpmNorm * 0.85;
    const idleVol = THREE.MathUtils.clamp((1.0 - rpmNorm * 0.75) * 0.70, 0.12, 0.72);
    this.sources.engineIdle.gain.gain.setTargetAtTime(idleVol, now, 0.04);
    if (this.sources.engineIdle.source) {
      this.sources.engineIdle.source.playbackRate.setTargetAtTime(idlePitch, now, 0.035);
    }

    const cutAttenuation = state.cuttingRev ? 0.28 : 1.0;

    const midPitch = 0.58 + rpmNorm * 1.15;
    const midVol = THREE.MathUtils.clamp((rpmNorm * 0.75 + throttle * 0.25) * 0.72 * cutAttenuation, 0.0, 0.75);
    this.sources.engineLoad.gain.gain.setTargetAtTime(midVol, now, 0.035);
    if (this.sources.engineLoad.source) {
      this.sources.engineLoad.source.playbackRate.setTargetAtTime(midPitch, now, 0.03);
    }

    const highPitch = 0.55 + rpmNorm * 1.12;
    const highVol = THREE.MathUtils.clamp(Math.pow(rpmNorm, 1.1) * (0.50 + throttle * 0.45) * 0.78 * cutAttenuation, 0.0, 0.82);
    this.sources.exhaustLoad.gain.gain.setTargetAtTime(highVol, now, 0.035);
    if (this.sources.exhaustLoad.source) {
      this.sources.exhaustLoad.source.playbackRate.setTargetAtTime(highPitch, now, 0.03);
    }

    const revCutVol = state.cuttingRev ? 0.42 : 0.0;
    this.sources.revCutExhaust.gain.gain.setTargetAtTime(revCutVol, now, 0.025);
    this.sources.revCutEngine.gain.gain.setTargetAtTime(revCutVol * 0.60, now, 0.025);
  }
}

// ============================================================================
// 4. SISTEMA DE PARTÍCULAS 3D (FUMAÇA DE PNEU EM ARRANCADA/FREIO/DRIFT E ESCAPAMENTO)
// ============================================================================
class SmokeParticleSystem {
  constructor(scene, maxParticles = 320) {
    this.maxParticles = maxParticles;
    this.pool = [];
    this.index = 0;

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
    grad.addColorStop(0.0, 'rgba(235, 240, 245, 0.85)');
    grad.addColorStop(0.45, 'rgba(200, 208, 218, 0.45)');
    grad.addColorStop(1.0, 'rgba(160, 170, 180, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);

    this.geometry = new THREE.PlaneGeometry(1, 1);

    for (let i = 0; i < maxParticles; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.visible = false;
      scene.add(mesh);

      this.pool.push({
        mesh,
        mat,
        active: false,
        age: 0,
        maxAge: 1.0,
        vel: new THREE.Vector3(),
        startScale: 0.2,
        endScale: 1.5,
        startOpacity: 0.4,
        rotSpeed: 0,
        rotZ: 0
      });
    }
  }

  spawn(pos, vel, opts = {}) {
    const p = this.pool[this.index];
    this.index = (this.index + 1) % this.maxParticles;

    p.active = true;
    p.age = 0;
    p.maxAge = opts.maxAge ?? (0.9 + Math.random() * 0.7);
    p.startScale = opts.startScale ?? 0.22;
    p.endScale = opts.endScale ?? 1.85;
    p.startOpacity = opts.opacity ?? 0.42;
    p.rotZ = Math.random() * Math.PI * 2;
    p.rotSpeed = (Math.random() - 0.5) * 2.4;

    p.mat.color.setHex(opts.colorHex ?? 0xe2e8f0);
    p.mesh.position.copy(pos);
    p.vel.copy(vel);
    p.mesh.visible = true;
  }

  update(dt, camera) {
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.pool[i];
      if (!p.active) continue;

      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }

      const t = p.age / p.maxAge;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.pow(0.42, dt));
      p.vel.y += 0.55 * dt;

      const scale = THREE.MathUtils.lerp(p.startScale, p.endScale, Math.pow(t, 0.65));
      p.mesh.scale.set(scale, scale, scale);

      const fadeIn = Math.min(t * 5.0, 1.0);
      const fadeOut = 1.0 - Math.pow(t, 1.4);
      p.mat.opacity = p.startOpacity * fadeIn * fadeOut;

      p.mesh.quaternion.copy(camera.quaternion);
      p.rotZ += p.rotSpeed * dt;
      p.mesh.rotateZ(p.rotZ);
    }
  }
}

// ============================================================================
// 5. SEPARADOR CIRÚRGICO DO CORSA + FARÓIS HALÓGENOS (BRANCO QUENTE), FREIO E RÉ
// ============================================================================
let headlightMat = null;
let brakeLightMat = null;
let reverseLightMat = null;

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

    const clonedMat = mesh.material.clone();
    if (matName.includes('carpaint')) {
      clonedMat.metalness = 0.45;
      clonedMat.roughness = 0.22;
      clonedMat.envMapIntensity = 1.3;
    } else if (matName.includes('windowglass') || matName.includes('clearglass')) {
      clonedMat.transparent = true;
      clonedMat.opacity = 0.48;
      clonedMat.roughness = 0.08;
      clonedMat.metalness = 0.1;
    } else if (matName.includes('chrome') || matName.includes('rim')) {
      clonedMat.metalness = 0.85;
      clonedMat.roughness = 0.18;
    } else if (matName.includes('tire')) {
      clonedMat.roughness = 0.82;
      clonedMat.metalness = 0.05;
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
        buckets.brakelight.push(i0, i1, i2);
      } else if (matName === 'clearglass' && cz < -120) {
        buckets.headlight.push(i0, i1, i2);
      } else if (nodeName === 'object_41' && cz > 140) {
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

      const centerRaw = bIdx >= 0 ? WHEEL_HUBS_LOCAL[bIdx].rawCenter : new THREE.Vector3(0, 0, 0);
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
      else if (bKey === 'reverselight') matToUse = reverseLightMat;

      const subMesh = new THREE.Mesh(subGeom, matToUse);
      subMesh.castShadow = !['headlight', 'brakelight', 'reverselight'].includes(bKey);
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

  return {
    chassisGroup,
    wheelVisualGroups,
    chassisComOffsetY: CHASSIS_COM_OFFSET_Y
  };
}

// ============================================================================
// 6. COLISÃO ESTÁTICA SÓLIDA DO MAPA (ASFALTO 100% CONTÍNUO + OBSTÁCULOS SECTORIZADOS)
// ============================================================================
async function buildCityPhysicsFromModel(cityScene, physicsWorld, groundMaterial, wallMaterial, onProgress) {
  cityScene.updateMatrixWorld(true);

  const meshes = [];
  cityScene.traverse((child) => {
    if (child.isMesh && child.geometry && child.geometry.attributes.position) {
      child.castShadow = false;
      child.receiveShadow = true;
      meshes.push(child);
    }
  });

  const ROAD_SECTOR_SIZE = 40.0;
  const roadSectorMap = new Map();

  const wallSegments = [];
  const dedupWallSet = new Set();

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const meshAABB = new THREE.Box3();

  const totalMeshes = meshes.length;

  for (let m = 0; m < totalMeshes; m++) {
    const mesh = meshes[m];
    const geom = mesh.geometry;
    const pos = geom.attributes.position;

    // Descarte instantâneo por AABB do Mesh: se todo o objeto estiver acima ou abaixo da zona transitável, ignora!
    if (!geom.boundingBox) geom.computeBoundingBox();
    meshAABB.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
    if (meshAABB.min.y > 6.5 || meshAABB.max.y < -3.0) {
      continue;
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

      if (minY > 6.0 || maxY < -2.6) continue;

      edge1.subVectors(v1, v0);
      edge2.subVectors(v2, v0);
      normal.crossVectors(edge1, edge2);
      const doubleArea = normal.length();

      if (doubleArea < 0.0005) continue;
      normal.divideScalar(doubleArea);

      // 1. Asfalto, Avenidas, Calçadas, Pontes, Viadutos e Rampas: superfícies transitáveis (normal.y > 0.45)
      // Agrupamos por setores de 40m x 40m para que cada CANNON.Trimesh tenha no máximo ~1.700 triângulos,
      // eliminando buracos no asfalto e evitando o estouro do Int16Array do Cannon-es (< 32.767)!
      if (normal.y > 0.45 && maxY < 5.8 && minY > -2.5) {
        const midX = (v0.x + v1.x + v2.x) / 3;
        const midZ = (v0.z + v1.z + v2.z) / 3;
        const sx = Math.floor(midX / ROAD_SECTOR_SIZE);
        const sz = Math.floor(midZ / ROAD_SECTOR_SIZE);
        const sKey = `${sx}_${sz}`;

        let sRoad = roadSectorMap.get(sKey);
        if (!sRoad) {
          sRoad = { verts: [], indices: [], offset: 0 };
          roadSectorMap.set(sKey, sRoad);
        }
        sRoad.verts.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
        sRoad.indices.push(sRoad.offset, sRoad.offset + 1, sRoad.offset + 2);
        sRoad.offset += 3;
      }
      // 2. Cercas, Muretas, Guardrails e Fachadas de Prédios nas avenidas e pontes
      else if (Math.abs(normal.y) < 0.35 && (maxY - minY) > 0.40 && minY < 4.5 && maxY > -1.8) {
        let maxDist2D = 0;
        let bestA = v0;
        let bestB = v1;

        const d01 = Math.hypot(v1.x - v0.x, v1.z - v0.z);
        if (d01 > maxDist2D) { maxDist2D = d01; bestA = v0; bestB = v1; }
        const d12 = Math.hypot(v2.x - v1.x, v2.z - v1.z);
        if (d12 > maxDist2D) { maxDist2D = d12; bestA = v1; bestB = v2; }
        const d20 = Math.hypot(v0.x - v2.x, v0.z - v2.z);
        if (d20 > maxDist2D) { maxDist2D = d20; bestA = v2; bestB = v0; }

        if (maxDist2D >= 0.70) {
          const midX = (bestA.x + bestB.x) * 0.5;
          const midY = (minY + maxY) * 0.5;
          const midZ = (bestA.z + bestB.z) * 0.5;
          const angleY = Math.atan2(bestB.x - bestA.x, bestB.z - bestA.z);

          const dedupKey = `${Math.round(midX / 2.5)}_${Math.round(midZ / 2.5)}_${Math.round(midY / 1.5)}_${Math.round(angleY * 1.5)}`;
          if (!dedupWallSet.has(dedupKey)) {
            dedupWallSet.add(dedupKey);
            wallSegments.push({
              x: midX,
              y: midY,
              z: midZ,
              len: Math.max(0.8, Math.min(maxDist2D, 6.0)),
              height: Math.max(0.8, Math.min(maxY - minY, 2.5)),
              angleY
            });
          }
        }
      }
    }

    // Libera a thread do navegador periodicamente para atualização fluida da barra de progresso
    if (m % 120 === 0) {
      if (onProgress) {
        const pct = Math.round((m / totalMeshes) * 100);
        onProgress(pct, `Processando geometria do mapa 3D (${pct}%)...`);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (onProgress) {
    onProgress(90, 'Construindo malha física do asfalto contínuo...');
  }
  await new Promise((r) => setTimeout(r, 0));

  // Cria os corpos sólidos de Asfalto setorizados (Trimesh ultra-estável por setor)
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
    roadBody.collisionFilterGroup = COLLISION_GROUND;
    roadBody.collisionFilterMask = COLLISION_CHASSIS | COLLISION_WALLS;
    physicsWorld.addBody(roadBody);
  });

  if (onProgress) {
    onProgress(95, 'Distribuindo obstáculos e cercas em setores espaciais otimizados...');
  }
  await new Promise((r) => setTimeout(r, 0));

  // Agrupamento dos obstáculos em corpos espaciais independentes (Setores 35m x 35m)
  // Isso elimina a lentidão O(N²) de adicionar milhares de formas em um único corpo!
  const SECTOR_SIZE = 35.0;
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
  const MAX_SHAPES_PER_BODY = 35;

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
        const box = new CANNON.Box(new CANNON.Vec3(0.20, seg.height * 0.5, seg.len * 0.5));
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
  safetyPlane.position.set(0, -3.5, 0);
  safetyPlane.collisionFilterGroup = COLLISION_GROUND | COLLISION_WALLS;
  safetyPlane.collisionFilterMask = COLLISION_CHASSIS | COLLISION_GROUND;
  physicsWorld.addBody(safetyPlane);

  console.log(
    `Mapa 3D Carregado com sucesso: ${totalRoadTris} triângulos de asfalto em ${roadSectorMap.size} setores e ${wallSegments.length} obstáculos em ${sectorGroups.size} setores espaciais!`
  );
}

// ============================================================================
// 7. INICIALIZAÇÃO DO CENÁRIO 3D, LUZES DO CARRO, FÍSICA E LOOP PRINCIPAL
// ============================================================================
const container = document.getElementById('canvas-container');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b8de);
scene.fog = new THREE.FogExp2(0x87b8de, 0.0018);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.08, 900);

const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x334155, 1.0);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfffbeb, 2.0);
sunLight.position.set(60, 95, 45);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 1024;
sunLight.shadow.mapSize.height = 1024;
sunLight.shadow.camera.near = 10;
sunLight.shadow.camera.far = 160;
const d = 16;
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);
scene.add(sunLight.target);

// Mundo Físico Cannon-es
const world = new CANNON.World();
world.gravity.set(0, -9.81, 0);
world.broadphase = new CANNON.SAPBroadphase(world);
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

const smokeSystem = new SmokeParticleSystem(scene, 320);
const carAudio = new SpatialCarAudio(camera);

let vehicle = null;
let chassisBody = null;
let corsaChassisVisual = null;
let corsaWheelVisuals = [];

// Luzes funcionais 3D do Corsa (Faróis Halógenos Branco-Quente, Luz de Freio Suave e Luz de Ré)
let headlightSpotL = null;
let headlightSpotR = null;
let headlightGlowL = null;
let headlightGlowR = null;
let brakeLightSpotL = null;
let brakeLightSpotR = null;
let reverseLightSpotL = null;
let reverseLightSpotR = null;

const wheelSpinAngles = [0, 0, 0, 0];

const progressFill = document.getElementById('progress-bar-fill');
const loadingStatus = document.getElementById('loading-status');
const startBtn = document.getElementById('start-btn');

function setupCarLights(chassisGroup) {
  const warmHalogenColor = 0xffe082;

  headlightSpotL = new THREE.SpotLight(warmHalogenColor, 0, 36, Math.PI * 0.23, 0.55, 1.4);
  headlightSpotL.position.set(-0.52 * CAR_SCALE, 0.11 * CAR_SCALE, -1.72 * CAR_SCALE);
  headlightSpotL.target.position.set(-0.48 * CAR_SCALE, -0.34 * CAR_SCALE, -14.0 * CAR_SCALE);
  chassisGroup.add(headlightSpotL, headlightSpotL.target);

  headlightSpotR = new THREE.SpotLight(warmHalogenColor, 0, 36, Math.PI * 0.23, 0.55, 1.4);
  headlightSpotR.position.set(0.52 * CAR_SCALE, 0.11 * CAR_SCALE, -1.72 * CAR_SCALE);
  headlightSpotR.target.position.set(0.48 * CAR_SCALE, -0.34 * CAR_SCALE, -14.0 * CAR_SCALE);
  chassisGroup.add(headlightSpotR, headlightSpotR.target);

  headlightGlowL = new THREE.PointLight(warmHalogenColor, 0, 1.4);
  headlightGlowL.position.set(-0.52 * CAR_SCALE, 0.11 * CAR_SCALE, -1.76 * CAR_SCALE);
  headlightGlowR = new THREE.PointLight(warmHalogenColor, 0, 1.4);
  headlightGlowR.position.set(0.52 * CAR_SCALE, 0.11 * CAR_SCALE, -1.76 * CAR_SCALE);
  chassisGroup.add(headlightGlowL, headlightGlowR);

  brakeLightSpotL = new THREE.PointLight(0xff2222, 0, 2.2);
  brakeLightSpotL.position.set(-0.64 * CAR_SCALE, 0.22 * CAR_SCALE, 1.75 * CAR_SCALE);
  brakeLightSpotR = new THREE.PointLight(0xff2222, 0, 2.2);
  brakeLightSpotR.position.set(0.64 * CAR_SCALE, 0.22 * CAR_SCALE, 1.75 * CAR_SCALE);
  chassisGroup.add(brakeLightSpotL, brakeLightSpotR);

  reverseLightSpotL = new THREE.PointLight(0xfff3c4, 0, 2.2);
  reverseLightSpotL.position.set(-0.62 * CAR_SCALE, 0.19 * CAR_SCALE, 1.76 * CAR_SCALE);
  reverseLightSpotR = new THREE.PointLight(0xfff3c4, 0, 2.2);
  reverseLightSpotR.position.set(0.62 * CAR_SCALE, 0.19 * CAR_SCALE, 1.76 * CAR_SCALE);
  chassisGroup.add(reverseLightSpotL, reverseLightSpotR);
}

async function initSimulation() {
  try {
    const gltfLoader = new GLTFLoader();

    loadingStatus.textContent = 'Carregando modelo 3D do Opel Corsa B 1998...';
    const corsaGltf = await new Promise((res, rej) => {
      gltfLoader.load(
        './opel_corsa_b_3door_1998.glb',
        res,
        (xhr) => {
          if (xhr.total) {
            progressFill.style.width = `${Math.round((xhr.loaded / xhr.total) * 35)}%`;
          }
        },
        rej
      );
    });

    loadingStatus.textContent = 'Configurando suspensão MacPherson, faróis halógenos, freio e ré...';
    const splitResult = splitCorsaModelIntoChassisAndWheels(corsaGltf.scene);
    corsaChassisVisual = splitResult.chassisGroup;
    corsaWheelVisuals = splitResult.wheelVisualGroups;

    setupCarLights(corsaChassisVisual);

    scene.add(corsaChassisVisual);
    corsaWheelVisuals.forEach((wg) => scene.add(wg));

    loadingStatus.textContent = 'Carregando mapa 3D da Cidade (city.glb)...';
    const cityGltf = await new Promise((res, rej) => {
      gltfLoader.load(
        './city.glb',
        res,
        (xhr) => {
          if (xhr.total) {
            progressFill.style.width = `${35 + Math.round((xhr.loaded / xhr.total) * 40)}%`;
          }
        },
        rej
      );
    });

    const cityRoot = cityGltf.scene;
    cityRoot.scale.set(CITY_SCALE, CITY_SCALE, CITY_SCALE);
    scene.add(cityRoot);

    loadingStatus.textContent = 'Construindo física do asfalto contínuo e obstáculos...';
    await buildCityPhysicsFromModel(cityRoot, world, groundMat, chassisMat, (pct, msg) => {
      progressFill.style.width = `${70 + Math.round(pct * 0.15)}%`;
      loadingStatus.textContent = msg;
    });

    loadingStatus.textContent = 'Sintetizando loops contínuos do motor, escapamento, corte de giro e derrapagem...';
    await carAudio.loadAll((p) => {
      progressFill.style.width = `${85 + Math.round(p * 15)}%`;
    });
    carAudio.setupNodes(corsaChassisVisual);

    setupCorsaPhysics(splitResult.chassisComOffsetY);

    state.loaded = true;
    progressFill.style.width = '100%';
    loadingStatus.textContent = 'Simulação pronta! Clique abaixo para girar a chave e ligar o Corsa.';
    startBtn.disabled = false;
  } catch (err) {
    console.error('Erro ao inicializar simulação:', err);
    loadingStatus.textContent = 'Erro ao carregar arquivos: ' + err.message;
  }
}

function setupCorsaPhysics(comOffsetY) {
  chassisBody = new CANNON.Body({
    mass: CORSA_SPECS.mass,
    material: chassisMat,
    linearDamping: 0.03,
    angularDamping: 0.40 // Amortecimento de guinada que confere peso de borracha no asfalto
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
    const connY = wheelHubY + CORSA_SPECS.suspensionRestLength - 0.03 * CAR_SCALE;
    const connZ = wInfo.pos.z;

    vehicle.addWheel({
      radius: CORSA_SPECS.wheelRadius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: CORSA_SPECS.suspensionStiffness,
      suspensionRestLength: CORSA_SPECS.suspensionRestLength,
      maxSuspensionTravel: CORSA_SPECS.maxSuspensionTravel,
      maxSuspensionForce: 25000,
      dampingCompression: CORSA_SPECS.dampingCompression,
      dampingRelaxation: CORSA_SPECS.dampingRelaxation,
      frictionSlip: CORSA_SPECS.frictionSlipNormal,
      rollInfluence: CORSA_SPECS.rollInfluence,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(connX, connY, connZ),
      isFrontWheel: wInfo.isFront,
      useCustomSlidingRotationalSpeed: false
    });
  });

  vehicle.addToWorld(world);
  resetCarToSpawn(0);
}

function resetCarToSpawn(spawnIndex = state.spawnIdx) {
  state.spawnIdx = spawnIndex % SPAWN_POINTS.length;
  const sp = SPAWN_POINTS[state.spawnIdx];

  chassisBody.position.set(sp.pos.x, sp.pos.y + 0.35, sp.pos.z);
  chassisBody.velocity.setZero();
  chassisBody.angularVelocity.setZero();
  chassisBody.quaternion.setFromEuler(0, sp.yaw, 0);
  chassisBody.wakeUp();

  state.rpm = state.engineOn ? CORSA_SPECS.IdleRPM : 0;
  state.gear = 1;
  state.currentSteer = 0;

  camCurrentPos.set(sp.pos.x, sp.pos.y + 1.4, sp.pos.z + 3.6);
  camCurrentLook.set(sp.pos.x, sp.pos.y + 0.25, sp.pos.z - 1.5);

  const spawnLabel = document.getElementById('spawn-label');
  if (spawnLabel) spawnLabel.textContent = `AVENIDA ${state.spawnIdx + 1}`;
}

// ============================================================================
// 8. DINÂMICA DO POWERTRAIN (FWD), DRIFT REAL NO FREIO DE MÃO E LUZES
// ============================================================================
const tempWheelPos = new THREE.Vector3();
const tempExhaustPos = new THREE.Vector3();
const tempChassisForward = new THREE.Vector3();
const tempChassisRight = new THREE.Vector3();

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

  const q = new THREE.Quaternion(
    chassisBody.quaternion.x,
    chassisBody.quaternion.y,
    chassisBody.quaternion.z,
    chassisBody.quaternion.w
  );
  tempChassisForward.set(0, 0, -1).applyQuaternion(q);
  tempChassisRight.set(1, 0, 0).applyQuaternion(q);

  const velVec = new THREE.Vector3(chassisBody.velocity.x, chassisBody.velocity.y, chassisBody.velocity.z);
  state.forwardSpeedMs = velVec.dot(tempChassisForward);
  const lateralSpeedMs = velVec.dot(tempChassisRight);

  // Velocidade aparente calibrada para o ritmo real do Corsa
  state.speedKmh = (Math.abs(state.forwardSpeedMs) / WORLD_SPEED_SCALE) * 3.6;

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

  // Direção assistida progressiva (Teclado A/D ou Joystick Analógico Virtual)
  let targetSteer = (keys.a ? 1 : 0) - (keys.d ? 1 : 0);
  if (Math.abs(state.touchInput.steer) > 0.01) {
    targetSteer = state.touchInput.steer;
  }
  const speedFactor = THREE.MathUtils.clamp(1.0 - (state.speedKmh / 180) * 0.55, 0.35, 1.0);
  const maxSteerNow = CORSA_SPECS.maxSteerAngle * speedFactor;
  state.currentSteer = THREE.MathUtils.lerp(state.currentSteer, targetSteer * maxSteerNow, Math.min(1, dt * 8.0));

  vehicle.setSteeringValue(state.currentSteer * (state.currentSteer > 0 ? 1.04 : 0.96), 0); // FL
  vehicle.setSteeringValue(state.currentSteer * (state.currentSteer < 0 ? 1.04 : 0.96), 1); // FR

  // ==========================================================================
  // FÍSICA DE CONDUÇÃO PRECISA & DRIFT EXCLUSIVO NO FREIO DE MÃO (ESTILO NFSU2)
  // ==========================================================================
  const isHandbraking = state.handbrakeInput > 0.45;
  const horizSpeed = Math.hypot(chassisBody.velocity.x, chassisBody.velocity.z);
  const isMovingFast = horizSpeed > 3.0 && state.speedKmh > 18;

  // O DRIFT SÓ ACONTECE SE O JOGADOR PUXAR O FREIO DE MÃO!
  // Se não estiver com o freio de mão puxado, o carro NÃO derrapa, garantindo 100% de aderência no asfalto!
  const isDrifting = isHandbraking && isMovingFast;
  state.isDrifting = isDrifting;

  // Ângulo de derrapagem / Slip Angle (diferença entre a direção do bico e o vetor velocidade)
  const driftSlipAngle = isDrifting
    ? Math.atan2(lateralSpeedMs, Math.max(1.2, Math.abs(state.forwardSpeedMs)))
    : 0;
  const absDriftAngle = Math.abs(driftSlipAngle);
  state.driftAngleDeg = (absDriftAngle * 180) / Math.PI;

  if (isDrifting) {
    // 1. Aderência calibrada para drift controlado (relação suave de pneus 2.70 na frente / 2.25 atrás)
    // Evita a chicotada violenta e permite que a traseira escorregue com peso e suavidade
    vehicle.wheelInfos[0].frictionSlip = 2.70;
    vehicle.wheelInfos[1].frictionSlip = 2.70;
    vehicle.wheelInfos[2].frictionSlip = 2.25;
    vehicle.wheelInfos[3].frictionSlip = 2.25;

    // 2. Trava absoluta de velocidade angular (Giro de no máximo 1.25 rad/s ~ 71°/s)
    // É ISSO QUE ELIMINA O 180° INSTANTÂNEO! O carro NUNCA gira rápido como pião!
    const MAX_DRIFT_YAW = 1.25;
    if (Math.abs(chassisBody.angularVelocity.y) > MAX_DRIFT_YAW) {
      chassisBody.angularVelocity.y = Math.sign(chassisBody.angularVelocity.y) * MAX_DRIFT_YAW;
    }

    // 3. Limitador Físico Rígido de Ângulo de Drift (~33 graus, padrão Need For Speed Underground 2)
    // Se o carro começar a passar de 33 graus, CORTA imediatamente a rotação e aplica contra-torque maciço
    const MAX_DRIFT_ANGLE = 0.58; // ~33 graus
    if (absDriftAngle > MAX_DRIFT_ANGLE) {
      // Zera a aceleração de giro que estava fazendo o carro rodar
      if (Math.sign(chassisBody.angularVelocity.y) === Math.sign(driftSlipAngle)) {
        chassisBody.angularVelocity.y *= 0.25;
      }
      const excess = absDriftAngle - MAX_DRIFT_ANGLE;
      const counterTorque = THREE.MathUtils.clamp(excess * 8500, 1200, 6000);
      chassisBody.applyTorque(new CANNON.Vec3(0, -Math.sign(driftSlipAngle) * counterTorque, 0));
    } else if (Math.abs(targetSteer) > 0.04) {
      const isCounter = (Math.sign(targetSteer) !== Math.sign(driftSlipAngle)) && absDriftAngle > 0.12;
      if (isCounter) {
        // Contra-esterço: resposta imediata no volante para alinhar o carro na saída da curva
        chassisBody.applyTorque(new CANNON.Vec3(0, Math.sign(targetSteer) * 1400, 0));
      } else {
        // Iniciação suave de curva no freio de mão
        chassisBody.applyTorque(new CANNON.Vec3(0, Math.sign(targetSteer) * 320, 0));
      }
    }

    // 4. Manutenção de velocidade na curva (puxada de FWD para não estancar o drift)
    if (state.throttleInput > 0.1) {
      const thrust = state.throttleInput * 420;
      chassisBody.applyForce(
        new CANNON.Vec3(tempChassisForward.x * thrust, 0, tempChassisForward.z * thrust),
        chassisBody.position
      );
    }
  } else {
    // CONDUÇÃO NORMAL: 100% DE ADERÊNCIA NO ASFALTO (SEM DERRAPAGENS EM CURVAS COMUNS)
    // O carro obedece ao volante como um esportivo de verdade, colado no asfalto!
    vehicle.wheelInfos[0].frictionSlip = CORSA_SPECS.frictionSlipNormal;
    vehicle.wheelInfos[1].frictionSlip = CORSA_SPECS.frictionSlipNormal;
    vehicle.wheelInfos[2].frictionSlip = CORSA_SPECS.frictionSlipNormal;
    vehicle.wheelInfos[3].frictionSlip = CORSA_SPECS.frictionSlipNormal;
  }

  if (state.shiftCooldown > 0) state.shiftCooldown = Math.max(0, state.shiftCooldown - dt);

  // Escalonamento de velocidades máximas por marcha (20, 50, 90, 120, 180 km/h)
  const maxGearSpeedKmh = CORSA_SPECS.gearMaxSpeedKmh[String(state.gear)] || 20;
  const speedRatioInGear = maxGearSpeedKmh > 0 ? state.speedKmh / maxGearSpeedKmh : 0;

  const wheelDrivenRPM = CORSA_SPECS.IdleRPM + speedRatioInGear * (CORSA_SPECS.RedlineRPM - CORSA_SPECS.IdleRPM);

  if (!state.engineOn) {
    state.rpm = THREE.MathUtils.lerp(state.rpm, 0, dt * 4);
    state.cuttingRev = false;
  } else {
    if (state.gear === 0) {
      const targetFreeRPM = CORSA_SPECS.IdleRPM + state.throttleInput * (CORSA_SPECS.MaxRPM - CORSA_SPECS.IdleRPM + 350);
      state.rpm = THREE.MathUtils.lerp(state.rpm, targetFreeRPM, dt * (state.throttleInput > 0.05 ? 6.5 : 4.5));
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
        const prevGearMax = CORSA_SPECS.gearMaxSpeedKmh[String(state.gear - 1)] || 20;
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

  // Curva de Torque Realista + Limitador Físico de Velocidade por Marcha
  const rpmNorm = THREE.MathUtils.clamp((state.rpm - 800) / 5800, 0, 1);
  const torqueCurve = 0.55 + 0.45 * Math.sin(rpmNorm * Math.PI * 0.85);
  let wheelDriveForce = 0;

  if (state.engineOn && state.gear !== 0 && state.shiftCooldown <= 0.05) {
    const baseGearForce = CORSA_SPECS.gearDriveForces[String(state.gear)] || 0;

    let speedLimiterFactor = 1.0;
    if (state.speedKmh >= maxGearSpeedKmh) {
      speedLimiterFactor = 0.0;
    } else if (state.speedKmh > maxGearSpeedKmh - 2.5) {
      speedLimiterFactor = (maxGearSpeedKmh - state.speedKmh) / 2.5;
    }

    wheelDriveForce = state.throttleInput * baseGearForce * torqueCurve * speedLimiterFactor;

    if (state.speedKmh > maxGearSpeedKmh + 1.5) {
      wheelDriveForce = -Math.sign(state.forwardSpeedMs) * 900;
    } else if (state.throttleInput < 0.05 && state.speedKmh > 4) {
      wheelDriveForce = -Math.sign(state.forwardSpeedMs) * (110 + rpmNorm * 180);
    }
  }

  const aeroDragForce = -Math.sign(state.forwardSpeedMs) * 0.55 * state.forwardSpeedMs * state.forwardSpeedMs;
  const totalFrontWheelForce = wheelDriveForce + aeroDragForce * 0.5;

  // TRAÇÃO DIANTEIRA (FWD): Força aplicada exclusivamente nas rodas 0 (FL) e 1 (FR)
  vehicle.applyEngineForce(totalFrontWheelForce, 0);
  vehicle.applyEngineForce(totalFrontWheelForce, 1);
  vehicle.applyEngineForce(0, 2);
  vehicle.applyEngineForce(0, 3);

  const serviceBrakeFront = state.brakeInput * 42;
  const serviceBrakeRear = state.brakeInput * 22;
  // Freio de mão calibrado para travar o giro traseiro mantendo o embalo e velocidade do drift
  const handbrakeRear = isHandbraking ? 12.0 : 0;

  vehicle.setBrake(serviceBrakeFront, 0);
  vehicle.setBrake(serviceBrakeFront, 1);
  vehicle.setBrake(Math.max(serviceBrakeRear, handbrakeRear), 2);
  vehicle.setBrake(Math.max(serviceBrakeRear, handbrakeRear), 3);

  // ==========================================================================
  // ATUALIZAÇÃO EM TEMPO REAL DOS FARÓIS (BRANCO QUENTE), FREIO E RÉ (BRILHO SUAVE)
  // ==========================================================================
  if (headlightMat) {
    headlightMat.emissive.setHex(state.headlightsOn ? 0xffd56b : 0x000000);
    headlightMat.emissiveIntensity = state.headlightsOn ? 1.15 : 0.0;
  }
  if (headlightSpotL && headlightSpotR) {
    const beamPower = state.headlightsOn ? 4.2 : 0.0;
    headlightSpotL.intensity = beamPower;
    headlightSpotR.intensity = beamPower;
    headlightGlowL.intensity = state.headlightsOn ? 0.85 : 0.0;
    headlightGlowR.intensity = state.headlightsOn ? 0.85 : 0.0;
  }

  const isBrakingNow = state.brakeInput > 0.08 || state.handbrakeInput > 0.08;
  if (brakeLightMat) {
    brakeLightMat.emissiveIntensity = isBrakingNow ? 1.45 : state.headlightsOn ? 0.32 : 0.0;
  }
  if (brakeLightSpotL && brakeLightSpotR) {
    const brakePointIntensity = isBrakingNow ? 1.65 : state.headlightsOn ? 0.35 : 0.0;
    brakeLightSpotL.intensity = brakePointIntensity;
    brakeLightSpotR.intensity = brakePointIntensity;
  }

  const isReverseEngaged = state.gear === -1;
  if (reverseLightMat) {
    reverseLightMat.emissiveIntensity = isReverseEngaged ? 1.25 : 0.0;
  }
  if (reverseLightSpotL && reverseLightSpotR) {
    const revIntensity = isReverseEngaged ? 1.35 : 0.0;
    reverseLightSpotL.intensity = revIntensity;
    reverseLightSpotR.intensity = revIntensity;
  }

  // Velocidade angular real de cada uma das 4 rodas
  for (let i = 0; i < 4; i++) {
    let wOmega = state.forwardSpeedMs / CORSA_SPECS.wheelRadius;
    if (i >= 2 && isHandbraking) {
      wOmega = 0; // Rodas traseiras travadas no freio de mão
    }
    if (i < 2 && state.engineOn && state.gear === 1 && state.throttleInput > 0.85 && state.speedKmh < 10) {
      wOmega += state.throttleInput * 7.0;
    }
    wheelSpinAngles[i] -= wOmega * dt;
  }

  const isHardBrakingHighSpeed = state.brakeInput > 0.75 && state.speedKmh > 35;
  const isHandbrakeDrifting = isHandbraking && state.speedKmh > 8;
  const isFastLaunchBurnout =
    state.engineOn &&
    state.throttleInput > 0.90 &&
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
    if (i < 2 && isFastLaunchBurnout) {
      wSkid = Math.max(wSkid, 0.78);
    }
    if (isHardBrakingHighSpeed) {
      wSkid = Math.max(wSkid, THREE.MathUtils.clamp((state.speedKmh - 28) / 60, 0.50, 1.0));
    }
    if (i >= 2 && (isHandbrakeDrifting || isDrifting)) {
      wSkid = Math.max(wSkid, 0.85);
    }

    state.wheelSkids[i] = wSkid;
    maxSkid = Math.max(maxSkid, wSkid);

    if (wSkid > 0.30 && Math.random() < wSkid * 0.92) {
      const wTransform = wi.worldTransform;
      tempWheelPos.set(
        wTransform.position.x + (Math.random() - 0.5) * 0.12,
        wTransform.position.y - CORSA_SPECS.wheelRadius + 0.05,
        wTransform.position.z + (Math.random() - 0.5) * 0.12
      );
      const smokeVel = new THREE.Vector3(
        -chassisBody.velocity.x * 0.22 + (Math.random() - 0.5) * 0.8,
        0.35 + Math.random() * 0.40,
        -chassisBody.velocity.z * 0.22 + (Math.random() - 0.5) * 0.8
      );
      smokeSystem.spawn(tempWheelPos, smokeVel, {
        startScale: 0.22,
        endScale: 1.55 + wSkid * 0.65,
        opacity: 0.38 * wSkid,
        maxAge: 0.95 + Math.random() * 0.60,
        colorHex: 0xdfe6ed
      });
    }
  }

  state.skidIntensity = THREE.MathUtils.lerp(state.skidIntensity, maxSkid, Math.min(1, dt * 12));

  if (state.engineOn) {
    const exhaustRate = 0.35 + state.throttleInput * 0.55 + (state.cuttingRev ? 0.35 : 0);
    if (Math.random() < exhaustRate) {
      carAudio.exhaustAnchor.getWorldPosition(tempExhaustPos);
      const jetSpeed = 1.2 + state.throttleInput * 2.8 + (state.cuttingRev ? 1.8 : 0);
      const exhaustVel = tempChassisForward
        .clone()
        .multiplyScalar(-jetSpeed)
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.30,
            0.20 + Math.random() * 0.25,
            (Math.random() - 0.5) * 0.30
          )
        );

      smokeSystem.spawn(tempExhaustPos, exhaustVel, {
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

  sunLight.position.set(
    chassisBody.position.x + 35,
    chassisBody.position.y + 70,
    chassisBody.position.z + 25
  );
  sunLight.target.position.copy(corsaChassisVisual.position);
}

// ============================================================================
// 9. CÂMERA COM DISTÂNCIA EQUILIBRADA E CAMPO DE VISÃO SUAVE
// ============================================================================
const camCurrentPos = new THREE.Vector3();
const camCurrentLook = new THREE.Vector3();
let smoothCamHeading = null;

function updateCamera(dt) {
  if (!corsaChassisVisual) return;

  const carPos = corsaChassisVisual.position;
  const carQuat = corsaChassisVisual.quaternion;

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(carQuat);
  const up = new THREE.Vector3(0, 1, 0);

  if (!smoothCamHeading) {
    smoothCamHeading = forward.clone();
  } else {
    smoothCamHeading.lerp(forward, Math.min(1.0, dt * 8.5)).normalize();
  }

  if (state.cameraMode === 0) {
    const dist = (5.35 + Math.min(state.speedKmh / 180, 1.0) * 0.55) * CAR_SCALE;
    const height = 1.62 * CAR_SCALE;
    const behind = smoothCamHeading.clone().multiplyScalar(-1);
    behind.applyAxisAngle(up, state.orbitYaw);

    camCurrentPos.copy(carPos).addScaledVector(behind, dist);
    camCurrentPos.y = carPos.y + height + Math.sin(state.orbitPitch) * (1.5 * CAR_SCALE);
    camCurrentLook.copy(carPos).add(new THREE.Vector3(0, 0.32 * CAR_SCALE, 0)).addScaledVector(smoothCamHeading, 1.4 * CAR_SCALE);
  } else if (state.cameraMode === 1) {
    camCurrentPos.copy(carPos).add(new THREE.Vector3(0, 0.68 * CAR_SCALE, -0.38 * CAR_SCALE).applyQuaternion(carQuat));
    const lookDir = forward.clone().applyAxisAngle(up, state.orbitYaw);
    camCurrentLook.copy(camCurrentPos).addScaledVector(lookDir, 10.0);
  } else if (state.cameraMode === 2) {
    camCurrentPos.copy(carPos).add(new THREE.Vector3(-0.62 * CAR_SCALE, 0.28 * CAR_SCALE, 3.05 * CAR_SCALE).applyQuaternion(carQuat));
    camCurrentLook.copy(carPos).add(new THREE.Vector3(-0.25 * CAR_SCALE, 0.05 * CAR_SCALE, 0.8 * CAR_SCALE).applyQuaternion(carQuat));
  } else {
    const radius = 3.9 * CAR_SCALE;
    const angle = state.orbitYaw;
    const localOffset = new THREE.Vector3(
      Math.sin(angle) * radius,
      (1.15 + Math.sin(state.orbitPitch) * 1.4) * CAR_SCALE,
      Math.cos(angle) * radius
    ).applyQuaternion(carQuat);
    camCurrentPos.copy(carPos).add(localOffset);
    camCurrentLook.copy(carPos).add(new THREE.Vector3(0, 0.22 * CAR_SCALE, 0));
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
  const r = 98;

  tachoCtx.clearRect(0, 0, w, h);

  const startAngle = Math.PI * 0.75;
  const endAngle = Math.PI * 2.25;
  const totalSweep = endAngle - startAngle;

  tachoCtx.beginPath();
  tachoCtx.arc(cx, cy, r, startAngle, endAngle);
  tachoCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  tachoCtx.lineWidth = 12;
  tachoCtx.lineCap = 'round';
  tachoCtx.stroke();

  const redStart = startAngle + (6000 / 7000) * totalSweep;
  tachoCtx.beginPath();
  tachoCtx.arc(cx, cy, r, redStart, endAngle);
  tachoCtx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
  tachoCtx.lineWidth = 12;
  tachoCtx.stroke();

  const rpmClamped = THREE.MathUtils.clamp(state.rpm, 0, 7000);
  const rpmAngle = startAngle + (rpmClamped / 7000) * totalSweep;
  if (rpmClamped > 50) {
    tachoCtx.beginPath();
    tachoCtx.arc(cx, cy, r, startAngle, rpmAngle);
    tachoCtx.strokeStyle = state.cuttingRev || state.rpm >= CORSA_SPECS.RedlineRPM ? '#ef4444' : '#38bdf8';
    tachoCtx.lineWidth = 12;
    tachoCtx.lineCap = 'round';
    tachoCtx.stroke();
  }

  tachoCtx.font = 'bold 12px Segoe UI, sans-serif';
  tachoCtx.textAlign = 'center';
  tachoCtx.textBaseline = 'middle';

  for (let i = 0; i <= 7; i++) {
    const a = startAngle + (i / 7) * totalSweep;
    const x1 = cx + Math.cos(a) * (r - 10);
    const y1 = cy + Math.sin(a) * (r - 10);
    const x2 = cx + Math.cos(a) * (r + 4);
    const y2 = cy + Math.sin(a) * (r + 4);

    tachoCtx.beginPath();
    tachoCtx.moveTo(x1, y1);
    tachoCtx.lineTo(x2, y2);
    tachoCtx.strokeStyle = i >= 6 ? '#ef4444' : '#cbd5e1';
    tachoCtx.lineWidth = 2.5;
    tachoCtx.stroke();

    const tx = cx + Math.cos(a) * (r - 24);
    const ty = cy + Math.sin(a) * (r - 24);
    tachoCtx.fillStyle = i >= 6 ? '#ef4444' : '#94a3b8';
    tachoCtx.fillText(String(i), tx, ty);
  }

  const needleAngle = rpmAngle;
  tachoCtx.save();
  tachoCtx.translate(cx, cy);
  tachoCtx.rotate(needleAngle);
  tachoCtx.beginPath();
  tachoCtx.moveTo(-14, 0);
  tachoCtx.lineTo(r - 8, 0);
  tachoCtx.strokeStyle = '#f59e0b';
  tachoCtx.lineWidth = 3.5;
  tachoCtx.lineCap = 'round';
  tachoCtx.stroke();
  tachoCtx.restore();

  tachoCtx.beginPath();
  tachoCtx.arc(cx, cy, 7, 0, Math.PI * 2);
  tachoCtx.fillStyle = '#f59e0b';
  tachoCtx.fill();
}

function updateHUD() {
  drawTachometer();

  document.getElementById('speed-value').textContent = Math.round(state.speedKmh);
  document.getElementById('rpm-readout').textContent = `${Math.round(state.rpm)} RPM`;

  const gearEl = document.getElementById('gear-display');
  const gearText = state.gear === -1 ? 'R' : state.gear === 0 ? 'N' : String(state.gear);
  gearEl.textContent = gearText;
  gearEl.classList.toggle('redline', state.cuttingRev || state.rpm >= CORSA_SPECS.RedlineRPM);

  const shiftLight = document.getElementById('redline-lamp');
  shiftLight.classList.toggle('active', state.cuttingRev || state.rpm >= CORSA_SPECS.RedlineRPM);

  document.getElementById('bar-throttle').style.height = `${Math.round(state.throttleInput * 100)}%`;
  document.getElementById('bar-brake').style.height = `${Math.round(state.brakeInput * 100)}%`;
  document.getElementById('bar-handbrake').style.height = `${Math.round(state.handbrakeInput * 100)}%`;

  const ids = ['fl', 'fr', 'rl', 'rr'];
  ids.forEach((id, idx) => {
    const suspBar = document.getElementById(`susp-${id}`);
    const slipDot = document.getElementById(`slip-${id}`);
    if (suspBar) suspBar.style.width = `${Math.round(state.wheelCompression[idx] * 100)}%`;
    if (slipDot) slipDot.classList.toggle('slipping', state.wheelSkids[idx] > 0.35);
  });

  const banner = document.getElementById('status-banner');
  if (state.cuttingRev) {
    const maxG = CORSA_SPECS.gearMaxSpeedKmh[String(state.gear)];
    banner.textContent =
      state.gear > 0 && state.gear < 5
        ? `LIMITE DA ${state.gear}ª MARCHA (${maxG} KM/H) — TROQUE DE MARCHA (+)`
        : 'CORTE DE GIRO ATIVO (6.500+ RPM)';
    banner.classList.remove('hud-hidden');
  } else if (state.isDrifting || state.skidIntensity > 0.45) {
    const angleText = state.driftAngleDeg > 5 ? ` (${Math.round(state.driftAngleDeg)}°)` : '';
    banner.textContent = state.handbrakeInput > 0.3
      ? `DRIFT NO FREIO DE MÃO${angleText}`
      : `DRIFT CONTROLADO • NFSU2${angleText}`;
    banner.classList.remove('hud-hidden');
  } else {
    banner.classList.add('hud-hidden');
  }

  // Atualiza estados dos botões touch para celular
  const mIgnitionTxt = document.getElementById('m-ignition-txt');
  const mBtnIgnition = document.getElementById('mbtn-ignition');
  if (mIgnitionTxt && mBtnIgnition) {
    if (state.startingEngine) {
      mIgnitionTxt.textContent = 'PARTIDA...';
      mBtnIgnition.classList.remove('active');
    } else {
      mIgnitionTxt.textContent = state.engineOn ? 'MOTOR: ON' : 'MOTOR: OFF';
      mBtnIgnition.classList.toggle('active', state.engineOn);
    }
  }

  const mLightsTxt = document.getElementById('m-lights-txt');
  const mBtnLights = document.getElementById('mbtn-lights');
  if (mLightsTxt && mBtnLights) {
    mLightsTxt.textContent = state.headlightsOn ? 'FARÓIS: ON' : 'FARÓIS: OFF';
    mBtnLights.classList.toggle('active', state.headlightsOn);
  }

  const mTransTxt = document.getElementById('m-trans-txt');
  const mGearCluster = document.getElementById('m-gear-cluster');
  if (mTransTxt) {
    mTransTxt.textContent = state.transmission;
  }
  if (mGearCluster) {
    mGearCluster.style.display = state.transmission === 'MANUAL' ? 'flex' : 'none';
  }

  const mSpawnTxt = document.getElementById('m-spawn-txt');
  if (mSpawnTxt) {
    mSpawnTxt.textContent = `AV. ${state.spawnIdx + 1}`;
  }
}

// ============================================================================
// 11. CONTROLES DE TECLADO (W, A, S, D, ESPAÇO, +, -, M, L, I, C, R) E BOTÕES HUD
// ============================================================================
function changeGear(newGear) {
  const clamped = THREE.MathUtils.clamp(newGear, -1, 5);
  if (clamped !== state.gear) {
    state.gear = clamped;
    state.shiftCooldown = 0.14;
  }
}

function toggleTransmissionMode() {
  state.transmission = state.transmission === 'MANUAL' ? 'AUTO' : 'MANUAL';
  document.getElementById('trans-label').textContent = state.transmission === 'MANUAL' ? 'MANUAL' : 'AUTOMÁTICO';
}

function toggleHeadlights() {
  state.headlightsOn = !state.headlightsOn;
  const btn = document.getElementById('btn-lights');
  const label = document.getElementById('lights-label');
  if (label) label.textContent = state.headlightsOn ? 'ON' : 'OFF';
  if (btn) btn.classList.toggle('lights-on', state.headlightsOn);
}

function toggleEngineIgnition() {
  if (state.startingEngine) return;
  const btn = document.getElementById('btn-ignition');
  const label = document.getElementById('engine-label');

  if (!state.engineOn) {
    state.startingEngine = true;
    label.textContent = 'PARTIDA...';
    carAudio.triggerIgnition(() => {
      state.engineOn = true;
      state.startingEngine = false;
      state.rpm = CORSA_SPECS.IdleRPM;
      btn.classList.remove('engine-off');
      btn.classList.add('engine-on');
      label.textContent = 'LIGADO';
    });
  } else {
    state.engineOn = false;
    state.rpm = 0;
    carAudio.shutDownEngine();
    btn.classList.remove('engine-on');
    btn.classList.add('engine-off');
    label.textContent = 'DESLIGADO';
  }
}

function cycleCameraMode() {
  state.cameraMode = (state.cameraMode + 1) % 4;
  state.orbitYaw = state.cameraMode === 3 ? Math.PI * 0.35 : 0;
  const names = ['PERSEGUIÇÃO', 'CAPÔ (MOTOR)', 'ESCAPAMENTO', 'ÓRBITA 3D'];
  document.getElementById('cam-label').textContent = names[state.cameraMode];
}

window.addEventListener('keydown', (e) => {
  if (!state.started) return;
  const k = e.key.toLowerCase();

  if (k === 'w' || e.key === 'ArrowUp') keys.w = true;
  if (k === 's' || e.key === 'ArrowDown') keys.s = true;
  if (k === 'a' || e.key === 'ArrowLeft') keys.a = true;
  if (k === 'd' || e.key === 'ArrowRight') keys.d = true;
  if (e.code === 'Space') {
    keys.space = true;
    e.preventDefault();
  }

  if (!e.repeat) {
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      changeGear(state.gear + 1);
    } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      changeGear(state.gear - 1);
    } else if (k === 'm') {
      toggleTransmissionMode();
    } else if (k === 'l') {
      toggleHeadlights();
    } else if (k === 'i') {
      toggleEngineIgnition();
    } else if (k === 'c') {
      cycleCameraMode();
    } else if (k === 'r') {
      resetCarToSpawn(state.spawnIdx);
    }
  }
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || e.key === 'ArrowUp') keys.w = false;
  if (k === 's' || e.key === 'ArrowDown') keys.s = false;
  if (k === 'a' || e.key === 'ArrowLeft') keys.a = false;
  if (k === 'd' || e.key === 'ArrowRight') keys.d = false;
  if (e.code === 'Space') keys.space = false;
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

  if (state.started) {
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

startBtn.addEventListener('click', () => {
  if (!state.loaded || state.started) return;
  state.started = true;

  document.getElementById('loading-overlay').classList.add('hud-hidden');
  document.getElementById('dashboard-hud').classList.remove('hud-hidden');

  setMobileMode(state.mobileMode);

  carAudio.startContinuousLoops();
  toggleEngineIgnition();
});

document.getElementById('btn-transmission').addEventListener('click', toggleTransmissionMode);
document.getElementById('btn-lights').addEventListener('click', toggleHeadlights);
document.getElementById('btn-ignition').addEventListener('click', toggleEngineIgnition);
document.getElementById('btn-camera').addEventListener('click', cycleCameraMode);
document.getElementById('btn-spawn').addEventListener('click', () => resetCarToSpawn(state.spawnIdx + 1));
document.getElementById('btn-reset').addEventListener('click', () => resetCarToSpawn(state.spawnIdx));

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
    if (chassisBody && chassisBody.position.y < -4.5) {
      resetCarToSpawn(state.spawnIdx);
    }
    updateVehiclePhysicsAndEffects(dt);
    syncVisualMeshes();
    updateCamera(dt);
    smokeSystem.update(dt, camera);
    carAudio.update(dt);
    if (state.started) updateHUD();
  }

  renderer.render(scene, camera);
}

initSimulation();
setupMobileControls();
requestAnimationFrame(animate);
