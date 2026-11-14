// Everything behind the diagram: a sky dome painted by a small shader
// (gradient, optional gas clouds, optional striped sun), fog, lights, stars,
// drifting motes and the floor grid — all taken from the chosen environment.

import { Grid, Sparkles, Stars } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BackSide, Color, ShaderMaterial, type Mesh } from 'three';
import type { Environment } from './environments';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom;
uniform vec3 nebA; uniform vec3 nebB; uniform float neb;
uniform vec3 sunColor; uniform float sun;
uniform float time;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }

void main() {
  vec3 d = normalize(vDir);
  vec3 col = d.y > 0.0 ? mix(horizon, top, pow(d.y, 0.5)) : mix(horizon, bottom, pow(-d.y, 0.35));

  if (neb > 0.0) {
    vec3 p = d * 2.2 + vec3(0.0, 0.0, time * 0.006);
    float a = fbm(p + fbm(p * 1.7) * 0.9);
    float b = fbm(p * 1.3 + 7.3);
    col += nebA * smoothstep(0.42, 0.85, a) * 0.55 * neb;
    col += nebB * smoothstep(0.5, 0.9, b) * 0.4 * neb;
  }

  if (sun > 0.0) {
    vec3 sd = normalize(vec3(0.0, 0.16, -1.0));
    float dist = distance(d, sd);
    float r = 0.24;
    float disc = smoothstep(r, r - 0.006, dist);
    // the lower half is cut into bands that widen toward the horizon
    float y = (d.y - sd.y) / r;
    float bands = y < 0.05 ? step(0.42 + y * 0.25, fract(y * 7.0 - time * 0.05)) : 1.0;
    vec3 face = mix(sunColor * vec3(1.25, 0.35, 0.75), sunColor * 1.35, smoothstep(-1.0, 1.0, y));
    col = mix(col, face, disc * bands * sun * step(0.0, d.y));
    col += sunColor * exp(-dist * 5.0) * 0.28 * sun;
    // a hot line where the sky meets the ground
    col += sunColor * vec3(1.0, 0.3, 0.8) * exp(-abs(d.y) * 60.0) * 0.5 * sun;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function Sky({ env, still }: { env: Environment; still: boolean }) {
  const mesh = useRef<Mesh>(null);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        toneMapped: false,
        uniforms: {
          top: { value: new Color() },
          horizon: { value: new Color() },
          bottom: { value: new Color() },
          nebA: { value: new Color() },
          nebB: { value: new Color() },
          neb: { value: 0 },
          sunColor: { value: new Color() },
          sun: { value: 0 },
          time: { value: 0 },
        },
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    const u = material.uniforms;
    u.top.value.set(env.sky.top);
    u.horizon.value.set(env.sky.horizon);
    u.bottom.value.set(env.sky.bottom);
    u.neb.value = env.nebula ? 1 : 0;
    if (env.nebula) {
      u.nebA.value.set(env.nebula[0]);
      u.nebB.value.set(env.nebula[1]);
    }
    u.sun.value = env.sun ? 1 : 0;
    if (env.sun) u.sunColor.value.set(env.sun);
  }, [env, material]);

  useFrame(({ camera, clock }) => {
    // the dome travels with the camera, so the sky is never reached
    mesh.current?.position.copy(camera.position);
    if (!still) material.uniforms.time.value = clock.elapsedTime;
  });

  return (
    <mesh ref={mesh} material={material} renderOrder={-1000} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[400, 48, 32]} />
    </mesh>
  );
}

const NO_MOTES = { color: '#ffffff', size: 4, speed: 0.3 };

export function Backdrop({ env, floor, phone, still }: { env: Environment; floor: number; phone: boolean; still: boolean }) {
  const motes = env.motes ?? NO_MOTES;
  return (
    <>
      <color attach="background" args={[env.sky.horizon]} />
      <fog attach="fog" args={[env.fog.color, env.fog.near, env.fog.far]} />
      <Sky env={env} still={still} />
      <ambientLight intensity={env.lights.ambient} />
      <directionalLight position={[20, 40, 30]} intensity={1.1} color={env.lights.key} />
      <pointLight position={[-30, 12, -20]} intensity={600} color={env.lights.a} />
      <pointLight position={[30, 8, 24]} intensity={500} color={env.lights.b} />
      {/* stars and motes stay mounted and are hidden when a world has none: switching worlds then never leaves a layer behind */}
      <group visible={env.stars}>
        <Stars radius={170} depth={60} count={phone ? 700 : 2400} factor={3.4} saturation={0.4} fade speed={still ? 0 : 0.4} />
      </group>
      <group visible={!!env.motes} position={[0, floor + 22, 0]}>
        <Sparkles scale={[150, 44, 150]} count={phone ? 80 : 240} size={motes.size} speed={still ? 0 : motes.speed} color={motes.color} opacity={0.7} noise={2} />
      </group>
      <Grid
        key={env.id}
        position={[0, floor, 0]}
        infiniteGrid
        cellSize={2}
        sectionSize={10}
        cellThickness={0.6}
        sectionThickness={1.15}
        cellColor={env.grid.cell}
        sectionColor={env.grid.section}
        fadeDistance={phone ? 210 : 190}
        fadeStrength={1.5}
      />
    </>
  );
}
