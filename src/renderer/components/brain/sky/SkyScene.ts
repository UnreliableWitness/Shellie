import * as THREE from 'three';
import { frameDue } from './frames';
import { SKY_TYPE_COLOR, SKY_TYPE_COLOR_LIGHT, type Sky } from './skyLayout';
import { DARK_SKY, type SkyTheme } from './skyTheme';

/** What is lit: the open page, the one under the pointer, the one the keys point at, or what a search found. */
export type SkyFocus = {
  selected: number | null;
  hovered: number | null;
  candidate: number | null;
  matches: ReadonlySet<number> | null;
};

/** A name to lay over the canvas, in CSS pixels from the host's top left. */
export type SkyLabel = {
  kind: 'chapter' | 'page';
  /** A cluster index for a chapter, a star index for a page. */
  index: number;
  x: number;
  y: number;
  alpha: number;
};

export type SkyHandlers = {
  onPick(star: number): void;
  onHover(star: number | null): void;
  /** Called with every drawn frame. */
  onLabels(labels: SkyLabel[]): void;
  /** The graphics context was lost and did not come back. */
  onLost(): void;
};

const NO_FOCUS: SkyFocus = {
  selected: null,
  hovered: null,
  candidate: null,
  matches: null,
};
const MIN_DIST = 12;
const MAX_DIST = 900;
/** How near the pointer has to be to a star to mean it, in px. */
const PICK_PX = 16;
/** Page names shown at once. */
const PAGE_LABELS = 22;
const NEIGHBOUR_LABELS = 14;
const FLY_MS = 1250;
const FIRST_FLY_MS = 2200;
/** The drift starts again this long after the last touch, in ms. */
const REST_MS = 2500;
/** How long a lost context may take to come back before the view gives up, in ms. */
const LOST_MS = 3000;

const VERTEX = `
attribute float aSize; attribute float aBright; attribute float aPhase; attribute float aNew; attribute float aLit;
attribute vec3 aColor;
uniform float uTime; uniform float uScale; uniform float uMin; uniform float uMax;
varying vec3 vColor; varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.88 + 0.12 * sin(uTime * 1.7 + aPhase);
  float pulse = 1.0 + aNew * 0.55 * (0.5 + 0.5 * sin(uTime * 3.0 + aPhase));
  // Capped, so a star flown up to stays a star and does not become a disc.
  gl_PointSize = clamp(aSize * pulse * uScale * (0.7 + 0.3 * min(aLit, 1.8)) / -mv.z, uMin, max(uMax, aSize * uMax / 12.0));
  vColor = aColor; vA = aBright * tw * aLit;
  gl_Position = projectionMatrix * mv;
}`;
const FRAGMENT = `
varying vec3 vColor; varying float vA; uniform float uLight;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.32, 0.0, d);
  float halo = pow(1.0 - d, 2.0);
  float lit = (halo * 0.85 + core) * vA;
  if (uLight > 0.5) {
    // On the light page a star is ink: its colour, deeper at the core, laid over the background.
    gl_FragColor = vec4(mix(vColor, vColor * 0.5, core * 0.8), clamp(lit * 1.25, 0.0, 1.0));
  } else {
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.8) * lit, 1.0);
  }
}`;

/** `#rrggbb` as three 0..1 numbers, as written: the shader draws them without a colour space step. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const ease = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const floats = (values: number[], size: number) =>
  new THREE.BufferAttribute(new Float32Array(values), size);

type Flight = {
  t0: number;
  ms: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  d0: number;
  d1: number;
  th0: number;
  th1: number;
};

/**
 * The brain's sky, drawn with three.js: stars, the threads between them, a glow per chapter and far dust, with a
 * camera that turns, zooms and flies. It knows nothing of React: the view tells it what to show and what is lit,
 * and hears what was picked. It draws only while running, within the frame budget of `frameDue`, and rebuilds
 * itself when the graphics context is lost and comes back.
 */
export class SkyScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
  private readonly world = new THREE.Group();
  private readonly starMaterial: THREE.ShaderMaterial;
  private readonly resizer: ResizeObserver;
  private readonly canvas: HTMLCanvasElement;
  private stars: THREE.Points | null = null;
  private haze: THREE.Points | null = null;
  private baseLines: THREE.LineSegments | null = null;
  private hotLines: THREE.LineSegments | null = null;
  private dots: THREE.Points | null = null;
  private dotSegments: number[] = [];
  private sky: Sky = { stars: [], links: [], clusters: [], total: 0 };
  private focus: SkyFocus = NO_FOCUS;
  private readonly view = {
    target: new THREE.Vector3(),
    theta: 0.3,
    phi: 1.25,
    dist: 300,
  };
  private overview = { target: new THREE.Vector3(), dist: 300 };
  private flight: Flight | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private moved = 0;
  private hovering = false;
  private dirty = true;
  private running = false;
  private lost = false;
  private lostTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private lastDraw = 0;
  private lastTouch = 0;
  private width = 1;
  private height = 1;
  private panelWidth = 0;
  private disposed = false;
  private readonly v = new THREE.Vector3();
  private theme: SkyTheme;
  private readonly dustPoints: THREE.Points;
  private ratioQuery: MediaQueryList | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly handlers: SkyHandlers,
    private readonly options: { reducedMotion: boolean; theme?: SkyTheme },
  ) {
    this.theme = options.theme ?? DARK_SKY;
    // Throws without WebGL: the view then shows the flat map.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    host.appendChild(this.canvas);
    this.scene.add(this.world);
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 1 },
        uMin: { value: 3 },
        uMax: { value: 90 },
        uLight: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    this.dustPoints = this.dust();
    this.scene.add(this.dustPoints);
    this.applyTheme();

    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerup', this.onUp);
    host.addEventListener('pointercancel', this.onUp);
    host.addEventListener('pointerleave', this.onLeave);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener(
      'webglcontextrestored',
      this.onContextRestored,
    );
    document.addEventListener('visibilitychange', this.onVisibility);
    this.watchRatio();
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(host);
    this.resize();
  }

  /**
   * Show this sky. The first one is flown into from far away; with `keep.camera` the camera stays where it is (the
   * brain changed while it was being looked at).
   */
  setSky(sky: Sky, keep?: { camera: boolean }): void {
    this.sky = sky;
    this.build();
    const box = new THREE.Box3();
    for (const s of sky.stars) box.expandByPoint(this.v.set(s.x, s.y, s.z));
    const sphere = new THREE.Sphere();
    if (sky.stars.length) box.getBoundingSphere(sphere);
    this.overview = {
      target: sphere.center.clone(),
      dist: Math.max(90, sphere.radius * 1.95),
    };
    if (!keep?.camera) {
      this.view.target.copy(this.overview.target);
      this.view.dist =
        this.overview.dist * (this.options.reducedMotion ? 1 : 1.9);
      this.fly(this.overview.target, this.overview.dist, FIRST_FLY_MS);
    }
    this.applyFocus();
  }

  /** The page's background and whether it is light: light is added on a dark page, ink laid over a light one. */
  setTheme(theme: SkyTheme): void {
    if (
      theme.light === this.theme.light &&
      theme.background === this.theme.background
    )
      return;
    this.theme = theme;
    this.applyTheme();
    // The stars' colours and the threads' materials are made per theme.
    this.build();
    this.applyFocus();
  }

  private get blending(): THREE.Blending {
    return this.theme.light ? THREE.NormalBlending : THREE.AdditiveBlending;
  }

  private applyTheme(): void {
    const { light, background } = this.theme;
    this.renderer.setClearColor(background, 1);
    this.starMaterial.uniforms.uLight.value = light ? 1 : 0;
    this.starMaterial.blending = this.blending;
    this.starMaterial.needsUpdate = true;
    const dust = this.dustPoints.material as THREE.PointsMaterial;
    dust.color.setHex(light ? 0x6b778c : 0x8fa6d8);
    dust.opacity = light ? 0.4 : 0.45;
    this.dirty = true;
    this.schedule();
  }

  setFocus(focus: SkyFocus): void {
    this.focus = focus;
    this.applyFocus();
  }

  flyToStar(star: number): void {
    const s = this.sky.stars[star];
    if (!s) return;
    this.fly(new THREE.Vector3(s.x, s.y, s.z), 30 + s.links.length * 1.2);
  }

  flyToOverview(): void {
    this.fly(this.overview.target, this.overview.dist);
  }

  /** The width of the panel laid over the scene's right side: the scene keeps its middle clear of it. */
  setPanelWidth(px: number): void {
    this.panelWidth = px;
    this.resize();
  }

  /** Off: no frame is drawn or asked for. */
  setRunning(on: boolean): void {
    this.running = on;
    this.dirty = true;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.lostTimer) clearTimeout(this.lostTimer);
    this.resizer.disconnect();
    const host = this.host;
    host.removeEventListener('pointerdown', this.onDown);
    host.removeEventListener('pointermove', this.onMove);
    host.removeEventListener('pointerup', this.onUp);
    host.removeEventListener('pointercancel', this.onUp);
    host.removeEventListener('pointerleave', this.onLeave);
    host.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this.onContextRestored,
    );
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.ratioQuery?.removeEventListener('change', this.onRatio);
    this.clear();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Points) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.starMaterial.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  /** Far dust, for depth; it belongs to no brain. */
  private dust(): THREE.Points {
    let seed = 99;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const count = 1600;
    const at = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.v
        .set(random() - 0.5, random() - 0.5, random() - 0.5)
        .normalize()
        .multiplyScalar(260 + random() * 700);
      at.set([this.v.x, this.v.y, this.v.z], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(at, 3));
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0x8fa6d8,
        size: 1.4,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
  }

  private clear(): void {
    for (const o of [
      this.stars,
      this.haze,
      this.baseLines,
      this.hotLines,
      this.dots,
    ]) {
      if (!o) continue;
      this.world.remove(o);
      o.geometry.dispose();
      if (o.material !== this.starMaterial)
        (o.material as THREE.Material).dispose();
    }
    this.stars = this.haze = this.dots = null;
    this.baseLines = this.hotLines = null;
  }

  /** The sky's geometry, from scratch: on a new sky and after a lost context. */
  private build(): void {
    this.clear();
    const { stars, clusters, links } = this.sky;
    const light = this.theme.light;
    const palette = light ? SKY_TYPE_COLOR_LIGHT : SKY_TYPE_COLOR;
    const colors = stars.flatMap((s) => rgb(palette[s.type]));
    const points = (
      position: number[],
      color: number[],
      size: number[],
      bright: number[],
      phase: number[],
      fresh: number[],
    ) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', floats(position, 3));
      g.setAttribute('aColor', floats(color, 3));
      g.setAttribute('aSize', floats(size, 1));
      g.setAttribute('aBright', floats(bright, 1));
      g.setAttribute('aPhase', floats(phase, 1));
      g.setAttribute('aNew', floats(fresh, 1));
      g.setAttribute(
        'aLit',
        floats(
          size.map(() => 1),
          1,
        ),
      );
      const p = new THREE.Points(g, this.starMaterial);
      p.frustumCulled = false;
      this.world.add(p);
      return p;
    };
    this.stars = points(
      stars.flatMap((s) => [s.x, s.y, s.z]),
      colors,
      stars.map((s) => s.size),
      stars.map((s) => s.bright),
      stars.map((_, i) => (i * 2.399963) % 6.283),
      stars.map((s) => (s.isNew ? 1 : 0)),
    );
    // A faint glow per chapter, so a cluster reads as one thing from far away.
    this.haze = points(
      clusters.flatMap((c) => [c.x, c.y, c.z]),
      clusters.flatMap(() => [0.35, 0.5, 0.95]),
      clusters.map((c) => c.r * 4.2),
      clusters.map(() => 0.085),
      clusters.map((_, i) => i),
      clusters.map(() => 0),
    );

    const base = new THREE.BufferGeometry();
    base.setAttribute(
      'position',
      floats(
        links.flatMap(([a, b]) => [
          stars[a].x,
          stars[a].y,
          stars[a].z,
          stars[b].x,
          stars[b].y,
          stars[b].z,
        ]),
        3,
      ),
    );
    base.setAttribute(
      'color',
      floats(
        links.flatMap(([a, b]) =>
          [a, b].flatMap((i) =>
            [0, 1, 2].map((k) => colors[i * 3 + k] * (light ? 1 : 0.5)),
          ),
        ),
        3,
      ),
    );
    const line = (geometry: THREE.BufferGeometry, color?: number) => {
      const l = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          ...(color === undefined ? { vertexColors: true } : { color }),
          transparent: true,
          opacity: color === undefined ? 0.38 : 0.85,
          blending: this.blending,
          depthWrite: false,
        }),
      );
      l.frustumCulled = false;
      this.world.add(l);
      return l;
    };
    this.baseLines = line(base);
    this.hotLines = line(
      new THREE.BufferGeometry(),
      light ? 0x0b5cad : 0xbfdcff,
    );
    this.dots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        color: light ? 0x201f1e : 0xffffff,
        size: 4,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
        blending: this.blending,
        depthWrite: false,
      }),
    );
    this.dots.frustumCulled = false;
    this.world.add(this.dots);
    this.dirty = true;
  }

  /** The star whose links are lit: the open page, else the one under the pointer. */
  private focusStar(): number | null {
    const { selected, hovered } = this.focus;
    const at = selected ?? hovered;
    return at !== null && this.sky.stars[at] ? at : null;
  }

  private applyFocus(): void {
    if (!this.stars || !this.hotLines || !this.dots || !this.baseLines) return;
    const { stars } = this.sky;
    const { selected, hovered, candidate, matches } = this.focus;
    const at = this.focusStar();
    const near = at === null ? null : new Set(stars[at].links);
    const lit = this.stars.geometry.getAttribute(
      'aLit',
    ) as THREE.BufferAttribute;
    for (let i = 0; i < stars.length; i++) {
      let v = 1;
      if (matches) v = matches.has(i) ? 1.7 : 0.1;
      else if (at !== null)
        v =
          i === at ? 1.9 : near!.has(i) ? 1.35 : selected !== null ? 0.2 : 0.5;
      if (i === candidate || i === hovered) v = Math.max(v, 1.9);
      lit.setX(i, v);
    }
    lit.needsUpdate = true;
    const segments =
      at === null || matches
        ? []
        : stars[at].links.flatMap((j) => [
            stars[at].x,
            stars[at].y,
            stars[at].z,
            stars[j].x,
            stars[j].y,
            stars[j].z,
          ]);
    this.hotLines.geometry.dispose();
    this.hotLines.geometry = new THREE.BufferGeometry();
    this.hotLines.geometry.setAttribute('position', floats(segments, 3));
    this.dots.geometry.dispose();
    this.dots.geometry = new THREE.BufferGeometry();
    this.dots.geometry.setAttribute(
      'position',
      floats(
        Array.from({ length: segments.length / 2 }, () => 0),
        3,
      ),
    );
    this.dotSegments = segments;
    this.dots.visible = !this.options.reducedMotion && segments.length > 0;
    (this.baseLines.material as THREE.LineBasicMaterial).opacity = matches
      ? 0.06
      : at === null
        ? 0.38
        : selected !== null
          ? 0.07
          : 0.18;
    this.dirty = true;
    this.schedule();
  }

  private fly(target: THREE.Vector3, dist: number, ms = FLY_MS): void {
    if (this.options.reducedMotion) {
      this.view.target.copy(target);
      this.view.dist = dist;
      this.flight = null;
    } else
      this.flight = {
        t0: performance.now(),
        ms,
        from: this.view.target.clone(),
        to: target.clone(),
        d0: this.view.dist,
        d1: dist,
        th0: this.view.theta,
        th1: this.view.theta + 0.55,
      };
    this.dirty = true;
    this.schedule();
  }

  private resize(): void {
    this.width = this.host.clientWidth || 1;
    this.height = this.host.clientHeight || 1;
    // Read again each time: the window may have moved to a display with another scaling.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    // Keep the scene's middle in the space the panel leaves free.
    if (this.panelWidth > 0 && this.width > this.panelWidth * 1.6)
      this.camera.setViewOffset(
        this.width,
        this.height,
        this.panelWidth / 2,
        0,
        this.width,
        this.height,
      );
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    const ratio = this.renderer.getPixelRatio();
    this.starMaterial.uniforms.uScale.value =
      (this.height * ratio) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.starMaterial.uniforms.uMin.value = 3 * ratio;
    this.starMaterial.uniforms.uMax.value = 90 * ratio;
    this.dirty = true;
    this.schedule();
  }

  /** A point in the sky as CSS pixels on the host, or null behind the camera. */
  private project(x: number, y: number, z: number): [number, number] | null {
    this.v.set(x, y, z).project(this.camera);
    if (this.v.z > 1) return null;
    return [
      (this.v.x * 0.5 + 0.5) * this.width,
      (-this.v.y * 0.5 + 0.5) * this.height,
    ];
  }

  private pick(clientX: number, clientY: number): number | null {
    const box = this.host.getBoundingClientRect();
    let best: number | null = null;
    let nearest = PICK_PX;
    this.sky.stars.forEach((s, i) => {
      const at = this.project(s.x, s.y, s.z);
      if (!at) return;
      const d = Math.hypot(
        at[0] - (clientX - box.left),
        at[1] - (clientY - box.top),
      );
      if (d < nearest) {
        nearest = d;
        best = i;
      }
    });
    return best;
  }

  private touched(): void {
    this.lastTouch = performance.now();
    this.dirty = true;
    this.schedule();
  }

  private readonly onDown = (e: PointerEvent) => {
    this.host.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    this.pinch = 0;
    this.flight = null;
    this.touched();
  };

  private readonly onMove = (e: PointerEvent) => {
    const held = this.pointers.get(e.pointerId);
    if (!held) {
      this.hovering = true;
      const over = this.pick(e.clientX, e.clientY);
      if (over !== this.focus.hovered) this.handlers.onHover(over);
      this.schedule();
      return;
    }
    if (this.pointers.size === 2) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...this.pointers.values()];
      const apart = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch) this.zoom(this.pinch / apart);
      this.pinch = apart;
      this.moved = 99;
    } else {
      const dx = e.clientX - held.x;
      const dy = e.clientY - held.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.view.theta += dx * 0.006;
      this.view.phi = Math.min(2.9, Math.max(0.25, this.view.phi - dy * 0.006));
    }
    this.touched();
  };

  private readonly onUp = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return;
    this.pinch = 0;
    if (e.type === 'pointerup' && this.moved < 6) {
      const star = this.pick(e.clientX, e.clientY);
      if (star !== null) this.handlers.onPick(star);
    }
    this.touched();
  };

  private readonly onLeave = () => {
    this.hovering = false;
    if (this.focus.hovered !== null) this.handlers.onHover(null);
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.flight = null;
    this.zoom(Math.exp(e.deltaY * 0.0012));
    this.touched();
  };

  private zoom(by: number): void {
    this.view.dist = Math.min(
      MAX_DIST,
      Math.max(MIN_DIST, this.view.dist * by),
    );
  }

  private readonly onContextLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lostTimer = setTimeout(() => {
      if (this.lost && !this.disposed) this.handlers.onLost();
    }, LOST_MS);
  };

  private readonly onContextRestored = () => {
    this.lost = false;
    if (this.lostTimer) clearTimeout(this.lostTimer);
    this.build();
    this.applyFocus();
  };

  /**
   * A move to a display with another scaling need not change the host's size, so no resize is seen: a media query
   * on the current ratio tells, once, and is asked again for the new ratio.
   */
  private watchRatio(): void {
    this.ratioQuery?.removeEventListener('change', this.onRatio);
    this.ratioQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio || 1}dppx)`,
    );
    this.ratioQuery.addEventListener('change', this.onRatio);
  }

  private readonly onRatio = () => {
    this.watchRatio();
    this.resize();
  };

  private readonly onVisibility = () => {
    this.dirty = true;
    this.schedule();
  };

  /** Ask for the next frame, unless there is nothing to draw it for. */
  private schedule(): void {
    if (
      this.raf ||
      this.disposed ||
      this.lost ||
      !this.running ||
      document.hidden
    )
      return;
    // With reduced motion and nothing to show, the loop stops until something changes.
    if (
      this.options.reducedMotion &&
      !this.dirty &&
      !this.flight &&
      !this.pointers.size
    )
      return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number) => {
    this.raf = 0;
    const due = frameDue(
      {
        flying: this.flight !== null,
        pointerDown: this.pointers.size > 0,
        hovering: this.hovering,
        reduced: this.options.reducedMotion,
        dirty: this.dirty,
      },
      now,
      this.lastDraw,
    );
    if (due) this.draw(now);
    this.schedule();
  };

  private draw(now: number): void {
    this.lastDraw = now;
    this.dirty = false;
    const view = this.view;
    const flight = this.flight;
    if (flight) {
      const t = Math.min(1, (now - flight.t0) / flight.ms);
      const k = ease(t);
      view.target.lerpVectors(flight.from, flight.to, k);
      view.dist = flight.d0 + (flight.d1 - flight.d0) * k;
      view.theta = flight.th0 + (flight.th1 - flight.th0) * k;
      if (t >= 1) this.flight = null;
    } else if (
      !this.options.reducedMotion &&
      !this.pointers.size &&
      now - this.lastTouch > REST_MS
    )
      view.theta += this.focus.selected === null ? 0.0022 : 0.0012;
    const ring = Math.sin(view.phi);
    this.camera.position.set(
      view.target.x + view.dist * ring * Math.cos(view.theta),
      view.target.y + view.dist * Math.cos(view.phi),
      view.target.z + view.dist * ring * Math.sin(view.theta),
    );
    this.camera.lookAt(view.target);
    if (!this.options.reducedMotion)
      this.starMaterial.uniforms.uTime.value = now / 1000;
    if (this.dots?.visible) {
      const s = this.dotSegments;
      const at = this.dots.geometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute;
      for (let i = 0; i < s.length / 6; i++) {
        const t = (now / 1400 + i * 0.37) % 1;
        at.setXYZ(
          i,
          s[i * 6] + (s[i * 6 + 3] - s[i * 6]) * t,
          s[i * 6 + 1] + (s[i * 6 + 4] - s[i * 6 + 1]) * t,
          s[i * 6 + 2] + (s[i * 6 + 5] - s[i * 6 + 2]) * t,
        );
      }
      at.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
    this.handlers.onLabels(this.labels());
  }

  /** The names to lay over this frame: chapters from far, pages once something is in focus. */
  private labels(): SkyLabel[] {
    const { stars, clusters } = this.sky;
    const { hovered, candidate, matches } = this.focus;
    const out: SkyLabel[] = [];
    const far = Math.min(1, Math.max(0, (this.view.dist - 40) / 60));
    clusters.forEach((c, index) => {
      const at = this.project(c.x, c.y + c.r * 0.95, c.z);
      const alpha = (matches ? 0.35 : 0.9) * far;
      if (at && alpha > 0.02)
        out.push({ kind: 'chapter', index, x: at[0], y: at[1], alpha });
    });
    const byLinks = (a: number, b: number) =>
      stars[b].links.length - stars[a].links.length;
    const want: number[] = [];
    const at = this.focusStar();
    if (matches)
      want.push(...[...matches].sort(byLinks).slice(0, NEIGHBOUR_LABELS));
    else if (at !== null)
      want.push(
        at,
        ...[...stars[at].links].sort(byLinks).slice(0, NEIGHBOUR_LABELS),
      );
    for (const extra of [hovered, candidate])
      if (extra !== null && stars[extra] && !want.includes(extra))
        want.push(extra);
    for (const index of want.slice(0, PAGE_LABELS)) {
      const s = stars[index];
      if (!s) continue;
      const p = this.project(s.x, s.y, s.z);
      if (p) out.push({ kind: 'page', index, x: p[0], y: p[1], alpha: 1 });
    }
    return out;
  }
}
