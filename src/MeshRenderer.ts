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

  // Wireframe overlay: same positions, drawn as lines with a flat colour
  private lineProgram: WebGLProgram | null = null;
  private lineVao: WebGLVertexArrayObject | null = null;
  private lineIndexBuffer: WebGLBuffer | null = null;
  private lineIndexCount: number = 0;
  private uLineMatrix: WebGLUniformLocation | null = null;
  private uLineColor: WebGLUniformLocation | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
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
      uniform bool u_wrapU;

      out vec4 fragColor;

      void main() {
        // Discard fragments outside texture bounds. When the source is a
        // full 360 degrees wide, u is periodic and the sampler REPEATs.
        if (v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
          discard;
        }
        if (!u_wrapU && (v_texCoord.x < 0.0 || v_texCoord.x > 1.0)) {
          discard;
        }
        fragColor = texture(u_texture, v_texCoord);
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

  updateTexture(image: HTMLImageElement | HTMLCanvasElement): void {
    const gl = this.gl;
    
    if (!this.texture) {
      this.setTexture(image);
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
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

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }
}
