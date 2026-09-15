const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
uniform vec2 u_resolution;
uniform vec2 u_camera;
uniform float u_zoom;

void main() {
  vec2 screen = (a_position - u_camera) * u_zoom + u_resolution * 0.5;
  vec2 zeroToOne = screen / u_resolution;
  vec2 clip = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;

void main() {
  outColor = u_color;
}`;

const SPRITE_VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
uniform vec2 u_resolution;
uniform vec2 u_camera;
uniform float u_zoom;
out vec2 v_uv;

void main() {
  vec2 screen = (a_position - u_camera) * u_zoom + u_resolution * 0.5;
  vec2 zeroToOne = screen / u_resolution;
  vec2 clip = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`;

const SPRITE_FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
uniform sampler2D u_texture;
uniform vec4 u_tint;
in vec2 v_uv;
out vec4 outColor;

void main() {
  outColor = texture(u_texture, v_uv) * u_tint;
}`;

function hexToRgba(value, alpha = 1) {
  const hex = String(value ?? '#ffffff').replace('#', '');
  const normalized = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex.padEnd(6, 'f');
  const number = Number.parseInt(normalized.slice(0, 6), 16);
  if (!Number.isFinite(number)) return [1, 1, 1, alpha];
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255, alpha];
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || '未知 shader 错误';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || '未知 program 错误';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function createSpriteProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, SPRITE_VERTEX_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, SPRITE_FRAGMENT_SOURCE);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL sprite program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || '未知 sprite program 错误';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

export class NativeWebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance',
    });
    if (!this.gl) throw new Error('当前浏览器没有可用的 WebGL2');

    this.program = createProgram(this.gl);
    this.spriteProgram = createSpriteProgram(this.gl);
    this.positionBuffer = this.gl.createBuffer();
    this.spritePositionBuffer = this.gl.createBuffer();
    this.spriteUvBuffer = this.gl.createBuffer();
    this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
    this.resolutionLocation = this.gl.getUniformLocation(this.program, 'u_resolution');
    this.cameraLocation = this.gl.getUniformLocation(this.program, 'u_camera');
    this.zoomLocation = this.gl.getUniformLocation(this.program, 'u_zoom');
    this.colorLocation = this.gl.getUniformLocation(this.program, 'u_color');
    this.spritePositionLocation = this.gl.getAttribLocation(this.spriteProgram, 'a_position');
    this.spriteUvLocation = this.gl.getAttribLocation(this.spriteProgram, 'a_uv');
    this.spriteResolutionLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_resolution');
    this.spriteCameraLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_camera');
    this.spriteZoomLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_zoom');
    this.spriteTextureLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_texture');
    this.spriteTintLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_tint');
    this.spriteTexture = null;
    this.spriteReady = false;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.camera = { x: 800, y: 410, zoom: 0.72 };
    this.resize();

    this.gl.useProgram(this.program);
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.disable(this.gl.DEPTH_TEST);
  }

  loadTexture(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const gl = this.gl;
        const texture = gl.createTexture();
        if (!texture) {
          reject(new Error('无法创建手绘角色纹理'));
          return;
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.spriteTexture = texture;
        this.spriteReady = true;
        resolve();
      };
      image.onerror = () => reject(new Error(`无法加载手绘角色纹理：${url}`));
      image.src = url;
    });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width || this.canvas.clientWidth || 1);
    this.height = Math.max(1, rect.height || this.canvas.clientHeight || 1);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  begin(camera = this.camera) {
    this.camera = camera;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.035, 0.047, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.resolutionLocation, this.width, this.height);
    gl.uniform2f(this.cameraLocation, camera.x, camera.y);
    gl.uniform1f(this.zoomLocation, camera.zoom);
  }

  end() {}

  drawVertices(vertices, color, mode = this.gl.TRIANGLES, alpha = 1) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    const rgba = hexToRgba(color, alpha);
    gl.uniform4f(this.colorLocation, rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.drawArrays(mode, 0, vertices.length / 2);
  }

  drawSprite(x, y, width, height, spriteIndex, alpha = 1, tint = '#ffffff', flipX = false) {
    if (!this.spriteReady || !this.spriteTexture || !Number.isInteger(spriteIndex)) return;
    const gl = this.gl;
    const column = ((spriteIndex % 4) + 4) % 4;
    const row = Math.floor(spriteIndex / 4);
    const u1 = column / 4;
    const u2 = (column + 1) / 4;
    const v1 = row / 4;
    const v2 = (row + 1) / 4;
    const left = x - width / 2;
    const right = x + width / 2;
    const top = y - height / 2;
    const bottom = y + height / 2;
    const uvLeft = flipX ? u2 : u1;
    const uvRight = flipX ? u1 : u2;
    const positions = [left, top, right, top, right, bottom, left, top, right, bottom, left, bottom];
    const uvs = [uvLeft, v1, uvRight, v1, uvRight, v2, uvLeft, v1, uvRight, v2, uvLeft, v2];
    const rgba = hexToRgba(tint, alpha);

    gl.useProgram(this.spriteProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spritePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.spritePositionLocation);
    gl.vertexAttribPointer(this.spritePositionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteUvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.spriteUvLocation);
    gl.vertexAttribPointer(this.spriteUvLocation, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.spriteResolutionLocation, this.width, this.height);
    gl.uniform2f(this.spriteCameraLocation, this.camera.x, this.camera.y);
    gl.uniform1f(this.spriteZoomLocation, this.camera.zoom);
    gl.uniform4f(this.spriteTintLocation, rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.spriteTexture);
    gl.uniform1i(this.spriteTextureLocation, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawRect(x, y, width, height, color, alpha = 1) {
    const x1 = x - width / 2;
    const x2 = x + width / 2;
    const y1 = y - height / 2;
    const y2 = y + height / 2;
    this.drawVertices([x1, y1, x2, y1, x2, y2, x1, y1, x2, y2, x1, y2], color, this.gl.TRIANGLES, alpha);
  }

  drawCircle(x, y, radius, color, segments = 24, alpha = 1) {
    const vertices = [x, y];
    for (let index = 0; index <= segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      vertices.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    }
    const triangles = [];
    for (let index = 0; index < segments; index += 1) {
      triangles.push(vertices[0], vertices[1]);
      const first = 2 + index * 2;
      const second = first + 2;
      triangles.push(vertices[first], vertices[first + 1], vertices[second], vertices[second + 1]);
    }
    this.drawVertices(triangles, color, this.gl.TRIANGLES, alpha);
  }

  drawRing(x, y, radius, thickness, color, segments = 32, alpha = 1) {
    const vertices = [];
    const inner = Math.max(0.5, radius - thickness / 2);
    const outer = radius + thickness / 2;
    for (let index = 0; index < segments; index += 1) {
      const a1 = (index / segments) * Math.PI * 2;
      const a2 = ((index + 1) / segments) * Math.PI * 2;
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const c2 = Math.cos(a2);
      const s2 = Math.sin(a2);
      vertices.push(
        x + c1 * inner, y + s1 * inner,
        x + c1 * outer, y + s1 * outer,
        x + c2 * outer, y + s2 * outer,
        x + c1 * inner, y + s1 * inner,
        x + c2 * outer, y + s2 * outer,
        x + c2 * inner, y + s2 * inner,
      );
    }
    this.drawVertices(vertices, color, this.gl.TRIANGLES, alpha);
  }

  drawLine(x1, y1, x2, y2, thickness, color, alpha = 1) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    const nx = (-dy / length) * thickness / 2;
    const ny = (dx / length) * thickness / 2;
    this.drawVertices([
      x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny,
      x1 + nx, y1 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny,
    ], color, this.gl.TRIANGLES, alpha);
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.camera.x) * this.camera.zoom + this.width / 2,
      y: (y - this.camera.y) * this.camera.zoom + this.height / 2,
    };
  }

  screenToWorld(x, y) {
    return {
      x: this.camera.x + (x - this.width / 2) / this.camera.zoom,
      y: this.camera.y + (y - this.height / 2) / this.camera.zoom,
    };
  }
}

export { hexToRgba };
