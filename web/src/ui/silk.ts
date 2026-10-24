// The page background. Long satin folds laid on a slant, bent by fbm noise, with a light
// sliding across them, drawn by a WebGL fragment shader at the default speed.
// It pauses while the tab is hidden and holds still when the visitor prefers reduced motion.

const VERTEX = `attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

const FRAGMENT = `
precision highp float;
uniform vec2 R; uniform float T;

float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float n2(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0., a = .5; mat2 r = mat2(.8,.6,-.6,.8);
  for (int i = 0; i < 6; i++){ v += a*n2(p); p = r*p*2.02 + 3.1; a *= .5; }
  return v;
}
void main(){
  vec2 uv = gl_FragCoord.xy / R.y; float t = T*.05;
  // the folds run on a slant, from one corner of the screen to the other
  vec2 d = vec2(sin(.8), cos(.8));
  float w = fbm(uv*.9 + vec2(t*.6, -t*.4));
  float band = dot(uv, d)*2.4 + w*2.2 + .25*sin(dot(uv, vec2(d.y, -d.x))*1.7 + t*2.);
  float s = sin(band*3.14159);
  float shade = .5 + .5*s;
  float spec = pow(max(s, 0.), 10.) * (.6 + .4*sin(uv.x*1.3 - t*3.));
  float v = .035 + .16*shade + .42*spec;
  vec2 c = gl_FragCoord.xy / R - .5;
  v *= 1. - .55*dot(c, c);
  // a 1/255 dither so the long gradients never band (invisible, not a grain)
  v += (h21(gl_FragCoord.xy + fract(T)) - .5) / 255.;
  gl_FragColor = vec4(vec3(clamp(v, 0., 1.)), 1.);
}`;

const CLOCK_OFFSET = 40;
const MAX_STEP = 0.05;
const MAX_PIXEL_RATIO = 1.5;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Silk: cannot create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Silk: ${gl.getShaderInfoLog(shader) ?? "shader failed to compile"}`);
  }
  return shader;
}

/**
 * Starts the silk on a canvas. Returns a function that stops it and removes its listeners, or
 * null when WebGL is not available (the caller then falls back to a static background).
 */
export function startSilk(canvas: HTMLCanvasElement): (() => void) | null {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;

  let resolution: WebGLUniformLocation | null = null;
  let time: WebGLUniformLocation | null = null;
  const build = () => {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    resolution = gl.getUniformLocation(program, "R");
    time = gl.getUniformLocation(program, "T");
  };
  try {
    build();
  } catch (error) {
    console.error(error);
    return null;
  }

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let clock = 0;
  let last = 0;
  let frameId = 0;
  let lost = false;

  const draw = () => {
    if (lost) return;
    gl.uniform2f(resolution, canvas.width, canvas.height);
    gl.uniform1f(time, clock + CLOCK_OFFSET);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const frame = (now: number) => {
    clock += Math.max(0, Math.min(MAX_STEP, (now - last) / 1000));
    last = now;
    draw();
    frameId = requestAnimationFrame(frame);
  };
  const stopLoop = () => {
    cancelAnimationFrame(frameId);
    frameId = 0;
  };
  // The loop runs only while the tab is visible and motion is welcome; otherwise one still frame.
  const sync = () => {
    if (document.hidden || reduced.matches || lost) {
      stopLoop();
      if (!document.hidden) draw();
    } else if (!frameId) {
      last = performance.now();
      frameId = requestAnimationFrame(frame);
    }
  };
  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_RATIO);
    canvas.width = Math.floor(innerWidth * ratio);
    canvas.height = Math.floor(innerHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    draw();
  };
  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    stopLoop();
  };
  const onRestored = () => {
    lost = false;
    build();
    resize();
    sync();
  };

  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", sync);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  resize();
  sync();

  return () => {
    stopLoop();
    removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", sync);
    reduced.removeEventListener("change", sync);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}
