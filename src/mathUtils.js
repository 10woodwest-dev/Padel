// ============================================================================
// mathUtils.js — small helpers shared across modules. Plain objects {x,y,z}
// are used for physics state (cheap, no Three.js dependency); Three.js
// Vector3s are only used at the render boundary.
// ============================================================================

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// Frame-rate independent exponential smoothing: returns the new value of
// `current` moved toward `target` with time-constant-like rate `lambda`.
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vAdd = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const vSub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vScale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
export const vDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vCross = (a, b) =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const vLen = (a) => Math.hypot(a.x, a.y, a.z);
export const vLenSq = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const vCopy = (a) => v3(a.x, a.y, a.z);
export const vNorm = (a) => {
  const l = vLen(a);
  return l > 1e-9 ? vScale(a, 1 / l) : v3();
};
export const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const lenXZ = (a) => Math.hypot(a.x, a.z);

// Angle helpers (facing angles are yaw radians measured on the XZ plane,
// atan2(x, z) convention: 0 faces +z, PI faces -z).
export const yawOf = (dir) => Math.atan2(dir.x, dir.z);
export const dirOfYaw = (yaw) => v3(Math.sin(yaw), 0, Math.cos(yaw));
export const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// Deterministic-ish RNG helpers (Math.random wrapped for future seeding).
export const rand = (lo = 0, hi = 1) => lo + Math.random() * (hi - lo);
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);
// Approximate gaussian (sum of 3 uniforms has σ = 0.5, so ×2 normalises to
// σ = 1), good enough for error scatter.
export const randGauss = (std = 1) =>
  ((Math.random() + Math.random() + Math.random()) - 1.5) * 2 * std;
