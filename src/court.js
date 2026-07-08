// ============================================================================
// court.js — Builds the visual court: blue textured turf, white lines, net,
// back glass (3 m) + mesh above (to 4 m), stepped side glass at the corners
// (3 m for 2 m, then 2 m for 2 m), mesh along the middle 12 m, dark frame
// posts, surrounding environment and stadium-style lighting.
//
// NOTE: rendering only. Ball collision runs against analytic planes in
// ball.js using the same COURT constants, so visuals and physics can't drift.
// ============================================================================

import * as THREE from 'three';
import { COURT, NET, COLORS } from './constants.js';

export function buildCourt(scene) {
  const group = new THREE.Group();
  group.name = 'court';

  addFloor(group);
  addLines(group);
  addNet(group);
  addWalls(group);
  addEnvironment(group);
  addLights(scene);

  scene.add(group);
  return group;
}

// ---------------------------------------------------------------------------
// Floor — playing surface plus out-of-court apron, with a subtle procedural
// turf texture so movement is readable.
// ---------------------------------------------------------------------------
function addFloor(group) {
  const tex = makeTurfTexture();
  const court = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.width, COURT.length),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 })
  );
  court.rotation.x = -Math.PI / 2;
  court.receiveShadow = true;
  group.add(court);

  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 80),
    new THREE.MeshStandardMaterial({ color: COLORS.outerFloor, roughness: 1 })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.01;
  apron.receiveShadow = true;
  group.add(apron);
}

function makeTurfTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#2f6d9e';
  g.fillRect(0, 0, c.width, c.height);
  // sand-dressed turf noise
  for (let i = 0; i < 9000; i++) {
    const shade = Math.random();
    g.fillStyle = shade < 0.5 ? '#2b6494' : shade < 0.8 ? '#3577ab' : '#28598400';
    g.globalAlpha = 0.25;
    g.fillRect(Math.random() * 256, Math.random() * 512, 1.5, 1.5);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Lines — service lines 6.95 m from the net + centre line splitting the
// service area. Padel has NO baseline/sideline paint (walls are the bounds).
// ---------------------------------------------------------------------------
function addLines(group) {
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.lines, roughness: 0.8 });
  const mk = (w, l, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.005, l), mat);
    m.position.set(x, 0.003, z);
    m.receiveShadow = true;
    group.add(m);
  };
  const lw = COURT.lineWidth;
  // service lines (full width) on both halves
  mk(COURT.width, lw, 0, COURT.serviceLineZ);
  mk(COURT.width, lw, 0, -COURT.serviceLineZ);
  // centre service line from net to service line on each half (+20cm tick past it)
  mk(lw, COURT.serviceLineZ + 0.2, 0, (COURT.serviceLineZ + 0.2) / 2);
  mk(lw, COURT.serviceLineZ + 0.2, 0, -(COURT.serviceLineZ + 0.2) / 2);
}

// ---------------------------------------------------------------------------
// Net — sagging cord profile (0.92 m posts, 0.88 m centre), white top band,
// semi-transparent woven net material.
// ---------------------------------------------------------------------------
function addNet(group) {
  const netGroup = new THREE.Group();
  const segs = 24;
  // Build the net as a strip whose top edge follows the sag curve.
  const geo = new THREE.PlaneGeometry(COURT.width, 1, segs, 6);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = Math.abs(x) / COURT.halfWidth;
    const h = NET.heightCenter + (NET.heightPosts - NET.heightCenter) * t * t;
    // plane y in [-0.5, 0.5] -> [0, h]
    pos.setY(i, (pos.getY(i) + 0.5) * h);
  }
  geo.computeVertexNormals();
  const netMat = new THREE.MeshStandardMaterial({
    map: makeNetTexture(),
    transparent: true,
    side: THREE.DoubleSide,
    roughness: 1,
  });
  const net = new THREE.Mesh(geo, netMat);
  netGroup.add(net);

  // top band
  const bandPts = [];
  for (let i = 0; i <= segs; i++) {
    const x = -COURT.halfWidth + (i / segs) * COURT.width;
    const t = Math.abs(x) / COURT.halfWidth;
    bandPts.push(new THREE.Vector3(x, NET.heightCenter + (NET.heightPosts - NET.heightCenter) * t * t, 0));
  }
  const band = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bandPts), segs, NET.bandThickness / 2, 6),
    new THREE.MeshStandardMaterial({ color: COLORS.netBand, roughness: 0.6 })
  );
  band.castShadow = true;
  netGroup.add(band);

  // posts just outside the playing width
  const postMat = new THREE.MeshStandardMaterial({ color: COLORS.frame, roughness: 0.5, metalness: 0.6 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, NET.heightPosts + 0.05, 10), postMat);
    post.position.set(sx * (COURT.halfWidth + 0.05), (NET.heightPosts + 0.05) / 2, 0);
    post.castShadow = true;
    netGroup.add(post);
  }
  group.add(netGroup);
}

function makeNetTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(16,20,24,0.9)';
  g.lineWidth = 2;
  for (let i = 0; i <= 128; i += 8) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 3);
  return tex;
}

// ---------------------------------------------------------------------------
// Walls — glass panels with steel frames + wire mesh sections, matching the
// collision layout in ball.js:
//   back walls  : glass to 3 m, mesh 3→4 m
//   side walls  : from each back corner, glass 3 m high × 2 m, glass 2 m
//                 high × 2 m, then mesh (3 m) for the middle 12 m; mesh tops
//                 up the corner sections to 4 m/3 m.
// ---------------------------------------------------------------------------
function addWalls(group) {
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: COLORS.glassTint,
    transparent: true,
    opacity: 0.14,
    roughness: 0.05,
    metalness: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const frameMat = new THREE.MeshStandardMaterial({ color: COLORS.frame, roughness: 0.5, metalness: 0.7 });
  const meshTex = makeMeshTexture();
  const meshMat = new THREE.MeshStandardMaterial({
    map: meshTex, transparent: true, side: THREE.DoubleSide, roughness: 0.9, alphaTest: 0.05,
  });

  const glassPanel = (w, h, x, y, z, rotY = 0) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat);
    p.position.set(x, y, z);
    p.rotation.y = rotY;
    group.add(p);
    // slim frame outline for readability
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)),
      new THREE.LineBasicMaterial({ color: 0x9db8c4, transparent: true, opacity: 0.5 })
    );
    edges.position.copy(p.position);
    edges.rotation.copy(p.rotation);
    group.add(edges);
  };
  const meshPanel = (w, h, x, y, z, rotY = 0) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), meshMat);
    p.position.set(x, y, z);
    p.rotation.y = rotY;
    group.add(p);
  };
  const post = (x, z, h) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.09, h, 0.09), frameMat);
    p.position.set(x, h / 2, z);
    p.castShadow = true;
    group.add(p);
  };

  const HW = COURT.halfWidth, HL = COURT.halfLength;

  for (const sz of [-1, 1]) {
    // ---- back wall: 4 glass panels wide (visual split), mesh strip above
    for (let i = 0; i < 4; i++) {
      const w = COURT.width / 4;
      glassPanel(w, COURT.backGlassHeight, -HW + w * (i + 0.5), COURT.backGlassHeight / 2, sz * HL);
    }
    meshPanel(COURT.width, COURT.backTotalHeight - COURT.backGlassHeight,
      0, (COURT.backGlassHeight + COURT.backTotalHeight) / 2, sz * HL);
    post(-HW, sz * HL, COURT.backTotalHeight);
    post(HW, sz * HL, COURT.backTotalHeight);
    post(0, sz * HL, COURT.backTotalHeight);
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // ---- stepped corner glass: 3 m high × 2 m, then 2 m high × 2 m
      const z1 = sz * (HL - COURT.sideGlassHighLength / 2);
      glassPanel(COURT.sideGlassHighLength, COURT.sideGlassHighHeight,
        sx * HW, COURT.sideGlassHighHeight / 2, z1, Math.PI / 2);
      const z2 = sz * (HL - COURT.sideGlassHighLength - COURT.sideGlassLowLength / 2);
      glassPanel(COURT.sideGlassLowLength, COURT.sideGlassLowHeight,
        sx * HW, COURT.sideGlassLowHeight / 2, z2, Math.PI / 2);
      // mesh above the corner glass (3→4 m over the tall panel, 2→3 m over the low one)
      meshPanel(COURT.sideGlassHighLength, 1, sx * HW, 3.5, z1, Math.PI / 2);
      meshPanel(COURT.sideGlassLowLength, 1, sx * HW, 2.5, z2, Math.PI / 2);
      post(sx * HW, sz * (HL - 2), 4);
      post(sx * HW, sz * (HL - 4), 3);
    }
    // ---- central side mesh: 12 m long, 3 m high
    meshPanel(COURT.length - 8, COURT.sideMeshHeight, sx * HW, COURT.sideMeshHeight / 2, 0, Math.PI / 2);
    post(sx * HW, -2, 3);
    post(sx * HW, 2, 3);
  }
}

function makeMeshTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(27,43,51,0.95)';
  g.lineWidth = 1.6;
  // diamond wire pattern
  for (let i = -128; i <= 256; i += 12) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke();
    g.beginPath(); g.moveTo(i, 128); g.lineTo(i + 128, 0); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 3);
  return tex;
}

// ---------------------------------------------------------------------------
// Environment — gradient sky dome, simple stands/banners for depth cues.
// ---------------------------------------------------------------------------
function addEnvironment(group) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(120, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(COLORS.skyTop) },
        bottom: { value: new THREE.Color(COLORS.skyBottom) },
      },
      vertexShader: `varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vp;
        void main(){ float t = clamp(vp.y/60.0+0.25, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, t), 1.0); }`,
    })
  );
  group.add(sky);

  // low sponsor hoardings around the apron for depth
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x14202b, roughness: 0.9 });
  for (const [w, d, x, z] of [
    [30, 0.3, 0, -16], [30, 0.3, 0, 16], [0.3, 44, -12, 0], [0.3, 44, 12, 0],
  ]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 1, d), boardMat);
    b.position.set(x, 0.5, z);
    group.add(b);
  }
}

// ---------------------------------------------------------------------------
// Lighting — 4 corner floodlights (padel-style masts), hemisphere ambience,
// one shadow-casting key light (keeps shadow cost down).
// ---------------------------------------------------------------------------
function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0x9cc0e0, 0x2e4058, 1.05));

  const key = new THREE.DirectionalLight(0xfff4e0, 1.5);
  key.position.set(8, 18, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -14; key.shadow.camera.right = 14;
  key.shadow.camera.top = 16; key.shadow.camera.bottom = -16;
  key.shadow.camera.far = 50;
  key.shadow.bias = -0.0005;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.4);
  fill.position.set(-10, 12, -8);
  scene.add(fill);

  // visible light masts at the four corners
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x10161b, roughness: 0.6, metalness: 0.5 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xdddddd, emissive: 0xf5f0dc, emissiveIntensity: 1.4,
  });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 6.5, 8), mastMat);
      mast.position.set(sx * (COURT.halfWidth + 0.6), 3.25, sz * (COURT.halfLength + 0.6));
      scene.add(mast);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.18), headMat);
      head.position.set(sx * (COURT.halfWidth + 0.5), 6.6, sz * (COURT.halfLength + 0.5));
      head.lookAt(0, 0, 0);
      scene.add(head);
    }
  }
}
