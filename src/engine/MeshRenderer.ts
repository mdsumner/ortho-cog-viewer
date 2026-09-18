/**
 * Minimal WebGL2 textured mesh renderer
 *
 * Renders our reprojection mesh with proper texture coordinate interpolation.
 * Designed to work alongside deck.gl (sharing the canvas).
 */

export interface MeshData {
  positions: Float32Array;  // xyz per vertex
  texCoords: Float32Array;  // uv per vertex
  indices: Uint32Array;
}

export class MeshRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private texture: WebGLTexture | null = null;
  private posBuffer: WebGLBuffer | null = null;
  private texBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCount: number = 0;

  // Uniform locations
  private uMatrix: WebGLUniformLocation | null = null;
  private uTexture: WebGLUniformLocation | null = null;
  private uWrapU: WebGLUniformLocation | null = null;
  private wrapU = false;

  // Numeric (single band float) mode
  private uCmap: WebGLUniformLocation | null = null;
  private uNumeric: WebGLUniformLocation | null = null;
  private uRange: WebGLUniformLocation | null = null;
  private uNodata: WebGLUniformLocation | null = null;
  private uHasNodata: WebGLUniformLocation | null = null;
  private uOpacity: WebGLUniformLocation | null = null;
  private uRgb: WebGLUniformLocation | null = null;
  private uCurve: WebGLUniformLocation | null = null;
  private numeric = false;
  private rgb = false;
  private curve = 0;

  // Hillshade state
  private uShade: WebGLUniformLocation | null = null;
  private uTexel: WebGLUniformLocation | null = null;
  private uGround: WebGLUniformLocation | null = null;
  private uGeo: WebGLUniformLocation | null = null;
  private uLatRange: WebGLUniformLocation | null = null;
  private uZfactor: WebGLUniformLocation | null = null;
  private uLight: WebGLUniformLocation | null = null;
  private uShadeStrength: WebGLUniformLocation | null = null;
  private shade = false;
  private texel: [number, number] = [0, 0];
  private ground: [number, number] = [1, 1];
  private geo = false;
  private latRange: [number, number] = [-90, 90];
  private zfactor = 1;
  private light: [number, number, number] = [0, 0, 1];
  private shadeStrength = 0.6;
  private range: [number, number] = [0, 1];
  private nodata: number | null = null;
  private opacity = 1;
  private cmapTexture: WebGLTexture | null = null;
  private floatLinear: boolean;

  // Wireframe overlay: same positions, drawn as lines with a flat colour
  private lineProgram: WebGLProgram | null = null;
  private lineVao: WebGLVertexArrayObject | null = null;
  private lineIndexBuffer: WebGLBuffer | null = null;
  private lineIndexCount: number = 0;
  private uLineMatrix: WebGLUniformLocation | null = null;
  private uLineColor: WebGLUniformLocation | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.initShaders();
  }

  private initShaders(): void {
    const gl = this.gl;

    const vsSource = `#version 300 es
      in vec3 a_position;
      in vec2 a_texCoord;

      uniform mat4 u_matrix;

      out vec2 v_texCoord;

      void main() {
        v_texCoord = a_texCoord;
        gl_Position = u_matrix * vec4(a_position, 1.0);
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;

      in vec2 v_texCoord;
      uniform sampler2D u_texture;
      uniform sampler2D u_cmap;
      uniform bool u_wrapU;
      uniform bool u_numeric;
      uniform bool u_rgb;        // 3-channel float composite
      uniform vec2 u_range;      // min, max
      uniform int u_curve;       // 0 linear, 1 sqrt, 2 log
      uniform float u_nodata;
      uniform bool u_hasNodata;
      uniform float u_opacity;

      // Hillshade (single band only)
      uniform bool u_shade;
      uniform vec2 u_texel;        // 1/width, 1/height of the data texture
      uniform vec2 u_ground;       // metres per texel in x and y (at the equator if geographic)
      uniform bool u_geo;          // geographic source: scale x by cos(lat)
      uniform vec2 u_latRange;     // texture minY, maxY in degrees (geographic only)
      uniform float u_zfactor;
      uniform vec3 u_light;        // unit vector towards the sun
      uniform float u_shadeStrength;

      out vec4 fragColor;

      float sampleZ(vec2 uv, float centre) {
        float v = texture(u_texture, uv).r;
        bool bad = isnan(v) || isinf(v) || (u_hasNodata && abs(v - u_nodata) <= 1e-6 * max(1.0, abs(u_nodata)));
        return bad ? centre : v;
      }

      // Horn (1981) slope/aspect from the 3x3 neighbourhood, lit by u_light.
      float hillshade(vec2 uv, float z) {
        vec2 t = u_texel;
        float a = sampleZ(uv + vec2(-t.x,  t.y), z), b = sampleZ(uv + vec2(0.0,  t.y), z), c = sampleZ(uv + vec2( t.x,  t.y), z);
        float d = sampleZ(uv + vec2(-t.x,  0.0), z),                                        f = sampleZ(uv + vec2( t.x,  0.0), z);
        float g = sampleZ(uv + vec2(-t.x, -t.y), z), h = sampleZ(uv + vec2(0.0, -t.y), z), i = sampleZ(uv + vec2( t.x, -t.y), z);
        float gx = u_ground.x;
        if (u_geo) {
          float lat = mix(u_latRange.y, u_latRange.x, uv.y);   // v=0 is the top row (maxY)
          gx *= max(0.05, cos(radians(lat)));
        }
        // Texture v increases southward (v = 0 is the north row), so the
        // +t.y samples (a, b, c) are the SOUTH row and g, h, i the north row.
        // The normal's y axis points north.
        float dzdx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * gx);
        float dzdy = ((g + 2.0 * h + i) - (a + 2.0 * b + c)) / (8.0 * u_ground.y);
        vec3 n = normalize(vec3(-dzdx * u_zfactor, -dzdy * u_zfactor, 1.0));
        return clamp(dot(n, u_light), 0.0, 1.0);
      }

      bool isNodata(float v) {
        if (isnan(v) || isinf(v)) return true;
        return u_hasNodata && abs(v - u_nodata) <= 1e-6 * max(1.0, abs(u_nodata));
      }

      float rescale(float v) {
        float t = clamp((v - u_range.x) / (u_range.y - u_range.x), 0.0, 1.0);
        if (u_curve == 1) t = sqrt(t);
        else if (u_curve == 2) t = log(1.0 + 9.0 * t) / log(10.0);
        return t;
      }

      void main() {
        // Discard fragments outside texture bounds. When the source is a
        // full 360 degrees wide, u is periodic and the sampler REPEATs.
        if (v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
          discard;
        }
        if (!u_wrapU && (v_texCoord.x < 0.0 || v_texCoord.x > 1.0)) {
          discard;
        }
        if (u_numeric && u_rgb) {
          vec3 v = texture(u_texture, v_texCoord).rgb;
          if (isNodata(v.r) || isNodata(v.g) || isNodata(v.b)) discard;
          fragColor = vec4(rescale(v.r), rescale(v.g), rescale(v.b), u_opacity);
        } else if (u_numeric) {
          float v = texture(u_texture, v_texCoord).r;
          if (isNodata(v)) discard;
          vec3 col = texture(u_cmap, vec2(rescale(v), 0.5)).rgb;
          if (u_shade) {
            float sh = hillshade(v_texCoord, v);
            // 0.5 is flat ground under a 45 degree sun; keep flat areas at full colour
            col *= mix(1.0, sh * 1.4, u_shadeStrength);
          }
          fragColor = vec4(col, u_opacity);
        } else {
          vec4 c = texture(u_texture, v_texCoord);
          fragColor = vec4(c.rgb, c.a * u_opacity);
        }
      }
    `;

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

    if (!vs || !fs) return;

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return;
    }

    this.program = program;
    this.uMatrix = gl.getUniformLocation(program, 'u_matrix');
    this.uTexture = gl.getUniformLocation(program, 'u_texture');
    this.uWrapU = gl.getUniformLocation(program, 'u_wrapU');
    this.uCmap = gl.getUniformLocation(program, 'u_cmap');
    this.uNumeric = gl.getUniformLocation(program, 'u_numeric');
    this.uRange = gl.getUniformLocation(program, 'u_range');
    this.uNodata = gl.getUniformLocation(program, 'u_nodata');
    this.uHasNodata = gl.getUniformLocation(program, 'u_hasNodata');
    this.uOpacity = gl.getUniformLocation(program, 'u_opacity');
    this.uRgb = gl.getUniformLocation(program, 'u_rgb');
    this.uCurve = gl.getUniformLocation(program, 'u_curve');
    this.uShade = gl.getUniformLocation(program, 'u_shade');
    this.uTexel = gl.getUniformLocation(program, 'u_texel');
    this.uGround = gl.getUniformLocation(program, 'u_ground');
    this.uGeo = gl.getUniformLocation(program, 'u_geo');
    this.uLatRange = gl.getUniformLocation(program, 'u_latRange');
    this.uZfactor = gl.getUniformLocation(program, 'u_zfactor');
    this.uLight = gl.getUniformLocation(program, 'u_light');
    this.uShadeStrength = gl.getUniformLocation(program, 'u_shadeStrength');

    // Wireframe program
    const lvs = this.compileShader(gl.VERTEX_SHADER, `#version 300 es
      in vec3 a_position;
      uniform mat4 u_matrix;
      void main() { gl_Position = u_matrix * vec4(a_position, 1.0); }
    `);
    const lfs = this.compileShader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform vec4 u_color;
      out vec4 fragColor;
      void main() { fragColor = u_color; }
    `);
    if (lvs && lfs) {
      const lp = gl.createProgram()!;
      gl.attachShader(lp, lvs);
      gl.attachShader(lp, lfs);
      gl.linkProgram(lp);
      if (gl.getProgramParameter(lp, gl.LINK_STATUS)) {
        this.lineProgram = lp;
        this.uLineMatrix = gl.getUniformLocation(lp, 'u_matrix');
        this.uLineColor = gl.getUniformLocation(lp, 'u_color');
      } else {
        console.error('Wireframe program link error:', gl.getProgramInfoLog(lp));
      }
    }
  }

  /**
   * Treat the texture as periodic in S (a source spanning all longitudes).
   */
  setWrapU(wrap: boolean): void {
    this.wrapU = wrap;
    if (this.texture) this.applyWrap();
  }

  private applyWrap(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this.wrapU ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  setMesh(mesh: MeshData): void {
    const gl = this.gl;

    // Allocate the VAO and buffers once; later calls just re-upload data.
    // The centred-projection mode calls this on every pan, so leaking a VAO
    // per call would be fatal.
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);

      this.posBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      const posLoc = gl.getAttribLocation(this.program!, 'a_position');
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

      this.texBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuffer);
      const texLoc = gl.getAttribLocation(this.program!, 'a_texCoord');
      gl.enableVertexAttribArray(texLoc);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

      this.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    } else {
      gl.bindVertexArray(this.vao);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.texCoords, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);

    this.indexCount = mesh.indices.length;

    gl.bindVertexArray(null);

    // Wireframe: three edges per triangle, sharing the position buffer
    if (this.lineProgram) {
      if (!this.lineVao) {
        this.lineVao = gl.createVertexArray();
        gl.bindVertexArray(this.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
        const loc = gl.getAttribLocation(this.lineProgram, 'a_position');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
        this.lineIndexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIndexBuffer);
      } else {
        gl.bindVertexArray(this.lineVao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIndexBuffer);
      }
      const tri = mesh.indices;
      const lines = new Uint32Array(tri.length * 2);
      for (let t = 0, k = 0; t < tri.length; t += 3) {
        const a = tri[t], b = tri[t + 1], c = tri[t + 2];
        lines[k++] = a; lines[k++] = b;
        lines[k++] = b; lines[k++] = c;
        lines[k++] = c; lines[k++] = a;
      }
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lines, gl.DYNAMIC_DRAW);
      this.lineIndexCount = lines.length;
      gl.bindVertexArray(null);
    }
  }

  /**
   * Draw the mesh edges with a flat colour, using the same view as
   * renderWithViewport. Call after the textured pass.
   */
  renderWireframe(
    centerX: number, centerY: number,
    zoom: number,
    color: [number, number, number, number] = [1, 1, 0, 0.5]
  ): void {
    const gl = this.gl;
    if (!this.lineProgram || !this.lineVao || this.lineIndexCount === 0) return;

    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    const scale = Math.pow(2, zoom);
    const halfWidth = canvas.clientWidth / scale / 2;
    const halfHeight = canvas.clientHeight / scale / 2;
    const matrix = this.createOrthoMatrix(
      centerX - halfWidth, centerX + halfWidth,
      centerY - halfHeight, centerY + halfHeight, -1, 1);

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.lineProgram);
    gl.bindVertexArray(this.lineVao);
    gl.uniformMatrix4fv(this.uLineMatrix, false, matrix);
    gl.uniform4f(this.uLineColor, color[0], color[1], color[2], color[3]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.LINES, this.lineIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Release GPU resources. Call when a layer is removed.
   */
  dispose(): void {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
    if (this.texBuffer) gl.deleteBuffer(this.texBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.cmapTexture) gl.deleteTexture(this.cmapTexture);
    this.cmapTexture = null;
    if (this.lineVao) gl.deleteVertexArray(this.lineVao);
    if (this.lineIndexBuffer) gl.deleteBuffer(this.lineIndexBuffer);
    this.lineVao = null;
    this.lineIndexBuffer = null;
    this.lineIndexCount = 0;
    this.vao = null;
    this.posBuffer = this.texBuffer = this.indexBuffer = null;
    this.texture = null;
    this.indexCount = 0;
  }

  setTexture(image: HTMLImageElement | HTMLCanvasElement): void {
    const gl = this.gl;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

    // Use linear filtering for smooth interpolation
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.applyWrap();
  }

  /**
   * Upload single-band float data as an R32F texture. Values are colour
   * mapped in the shader with setRange / setColormap, so changing the range
   * never touches the data.
   */
  updateFloatTexture(data: Float32Array, width: number, height: number, nodata: number | null, channels: 1 | 3 = 1): void {
    const gl = this.gl;
    if (!this.texture) this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (channels === 3) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, width, height, 0, gl.RGB, gl.FLOAT, data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
    }
    this.rgb = channels === 3;
    const filter = this.floatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    this.applyWrap();
    this.numeric = true;
    this.nodata = nodata;
    if (!this.cmapTexture) this.setColormap(new Uint8Array(256 * 4).fill(255));
  }

  setColormap(rgba256: Uint8Array): void {
    const gl = this.gl;
    if (!this.cmapTexture) this.cmapTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba256);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setRange(min: number, max: number): void {
    this.range = [min, max === min ? min + 1e-6 : max];
  }

  /**
   * Geometry of the data texture for hillshading: texel size and ground
   * distance per texel. Call after each float texture upload.
   */
  setTexelGeometry(width: number, height: number, groundX: number, groundY: number, geo: boolean, latMin: number, latMax: number): void {
    this.texel = [1 / width, 1 / height];
    this.ground = [Math.max(1e-9, groundX), Math.max(1e-9, groundY)];
    this.geo = geo;
    this.latRange = [latMin, latMax];
  }

  /**
   * @param azimuth  degrees clockwise from north
   * @param altitude degrees above the horizon
   */
  setHillshade(on: boolean, strength: number, zfactor: number, azimuth: number, altitude: number): void {
    this.shade = on;
    this.shadeStrength = Math.max(0, Math.min(1, strength));
    this.zfactor = zfactor;
    const az = azimuth * Math.PI / 180, alt = altitude * Math.PI / 180;
    // x east, y north, z up
    this.light = [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
  }

  setCurve(curve: 'linear' | 'sqrt' | 'log'): void {
    this.curve = curve === 'sqrt' ? 1 : curve === 'log' ? 2 : 0;
  }

  setNodata(nodata: number | null): void {
    this.nodata = nodata;
  }

  setOpacity(o: number): void {
    this.opacity = Math.max(0, Math.min(1, o));
  }

  updateTexture(image: HTMLImageElement | HTMLCanvasElement): void {
    const gl = this.gl;
    this.numeric = false;

    if (!this.texture) {
      this.setTexture(image);
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  private createOrthoMatrix(
    left: number, right: number,
    bottom: number, top: number,
    near: number, far: number
  ): Float32Array {
    const m = new Float32Array(16);
    m[0] = 2 / (right - left);
    m[5] = 2 / (top - bottom);
    m[10] = -2 / (far - near);
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
    m[14] = -(far + near) / (far - near);
    m[15] = 1;
    return m;
  }

  renderWithViewport(
    centerX: number, centerY: number,
    zoom: number,
    _viewportWidth: number, _viewportHeight: number
  ): void {
    const gl = this.gl;

    if (!this.program || !this.vao || !this.texture || this.indexCount === 0) {
      return;
    }

    // Get actual canvas size
    const canvas = gl.canvas as HTMLCanvasElement;

    // Set viewport to full canvas
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.SCISSOR_TEST);

    // Use CSS pixel dimensions for matrix calculation
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;

    const scale = Math.pow(2, zoom);
    const halfWidth = cssWidth / scale / 2;
    const halfHeight = cssHeight / scale / 2;

    const left = centerX - halfWidth;
    const right = centerX + halfWidth;
    const bottom = centerY - halfHeight;
    const top = centerY + halfHeight;

    const matrix = this.createOrthoMatrix(left, right, bottom, top, -1, 1);

    // Disable depth test - we're doing 2D
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniformMatrix4fv(this.uMatrix, false, matrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uTexture, 0);
    gl.uniform1i(this.uWrapU, this.wrapU ? 1 : 0);
    gl.uniform1i(this.uNumeric, this.numeric ? 1 : 0);
    gl.uniform2f(this.uRange, this.range[0], this.range[1]);
    gl.uniform1f(this.uNodata, this.nodata === null ? 0 : this.nodata);
    gl.uniform1i(this.uHasNodata, this.nodata === null ? 0 : 1);
    gl.uniform1f(this.uOpacity, this.opacity);
    gl.uniform1i(this.uRgb, this.rgb ? 1 : 0);
    gl.uniform1i(this.uCurve, this.curve);
    gl.uniform1i(this.uShade, this.shade && !this.rgb ? 1 : 0);
    gl.uniform2f(this.uTexel, this.texel[0], this.texel[1]);
    gl.uniform2f(this.uGround, this.ground[0], this.ground[1]);
    gl.uniform1i(this.uGeo, this.geo ? 1 : 0);
    gl.uniform2f(this.uLatRange, this.latRange[0], this.latRange[1]);
    gl.uniform1f(this.uZfactor, this.zfactor);
    gl.uniform3f(this.uLight, this.light[0], this.light[1], this.light[2]);
    gl.uniform1f(this.uShadeStrength, this.shadeStrength);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTexture);
    gl.uniform1i(this.uCmap, 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }

  render(viewProjectionMatrix: number[] | Float32Array): void {
    const gl = this.gl;

    if (!this.program || !this.vao || !this.texture) {
      return;
    }

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniformMatrix4fv(this.uMatrix, false, viewProjectionMatrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uTexture, 0);
    gl.uniform1i(this.uWrapU, this.wrapU ? 1 : 0);
    gl.uniform1i(this.uNumeric, this.numeric ? 1 : 0);
    gl.uniform2f(this.uRange, this.range[0], this.range[1]);
    gl.uniform1f(this.uNodata, this.nodata === null ? 0 : this.nodata);
    gl.uniform1i(this.uHasNodata, this.nodata === null ? 0 : 1);
    gl.uniform1f(this.uOpacity, this.opacity);
    gl.uniform1i(this.uRgb, this.rgb ? 1 : 0);
    gl.uniform1i(this.uCurve, this.curve);
    gl.uniform1i(this.uShade, this.shade && !this.rgb ? 1 : 0);
    gl.uniform2f(this.uTexel, this.texel[0], this.texel[1]);
    gl.uniform2f(this.uGround, this.ground[0], this.ground[1]);
    gl.uniform1i(this.uGeo, this.geo ? 1 : 0);
    gl.uniform2f(this.uLatRange, this.latRange[0], this.latRange[1]);
    gl.uniform1f(this.uZfactor, this.zfactor);
    gl.uniform3f(this.uLight, this.light[0], this.light[1], this.light[2]);
    gl.uniform1f(this.uShadeStrength, this.shadeStrength);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTexture);
    gl.uniform1i(this.uCmap, 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }
}
