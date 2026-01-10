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
  private indexCount: number = 0;
  private _lastLog: number = 0;

  // Uniform locations
  private uMatrix: WebGLUniformLocation | null = null;
  private uTexture: WebGLUniformLocation | null = null;

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

      out vec4 fragColor;

      void main() {
        // Discard fragments outside texture bounds
        if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 ||
            v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
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

    // Create VAO
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // Position buffer
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(this.program!, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

    // TexCoord buffer
    const texBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.texCoords, gl.STATIC_DRAW);

    const texLoc = gl.getAttribLocation(this.program!, 'a_texCoord');
    gl.enableVertexAttribArray(texLoc);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    // Index buffer
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    this.indexCount = mesh.indices.length;

    gl.bindVertexArray(null);
  }

  setTexture(image: HTMLImageElement | HTMLCanvasElement): void {
    const gl = this.gl;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

    // Use linear filtering for smooth interpolation
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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

    if (!this.program || !this.vao || !this.texture) {
      return;
    }

    // Get actual canvas size
    const canvas = gl.canvas as HTMLCanvasElement;
    
    // Debug - log once per second
    if (!this._lastLog || Date.now() - this._lastLog > 1000) {
      this._lastLog = Date.now();
      console.log('Canvas physical:', canvas.width, canvas.height);
      console.log('Canvas CSS:', canvas.clientWidth, canvas.clientHeight);
      console.log('Window:', window.innerWidth, window.innerHeight);
      console.log('DPR:', window.devicePixelRatio);
    }

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

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }
}
