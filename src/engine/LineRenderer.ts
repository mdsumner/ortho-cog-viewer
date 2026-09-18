/**
 * Flat-colour line renderer for overlays (graticule). Positions are xyz
 * pairs drawn with gl.LINES in display coordinates, using the same
 * orthographic view as the mesh renderer.
 */

export class LineRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private count = 0;
  private uMatrix: WebGLUniformLocation | null = null;
  private uColor: WebGLUniformLocation | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vs = this.compile(gl.VERTEX_SHADER, `#version 300 es
      in vec3 a_position;
      uniform mat4 u_matrix;
      void main() { gl_Position = u_matrix * vec4(a_position, 1.0); }
    `);
    const fs = this.compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform vec4 u_color;
      out vec4 fragColor;
      void main() { fragColor = u_color; }
    `);
    if (!vs || !fs) return;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('LineRenderer link error:', gl.getProgramInfoLog(p));
      return;
    }
    this.program = p;
    this.uMatrix = gl.getUniformLocation(p, 'u_matrix');
    this.uColor = gl.getUniformLocation(p, 'u_color');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const loc = gl.getAttribLocation(p, 'a_position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private compile(type: number, src: string): WebGLShader | null {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('LineRenderer shader error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  setLines(positions: Float32Array): void {
    const gl = this.gl;
    if (!this.buffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    this.count = positions.length / 3;
  }

  render(centerX: number, centerY: number, zoom: number, color: [number, number, number, number]): void {
    const gl = this.gl;
    if (!this.program || !this.vao || this.count === 0) return;

    const canvas = gl.canvas as HTMLCanvasElement;
    gl.viewport(0, 0, canvas.width, canvas.height);
    const scale = Math.pow(2, zoom);
    const hw = canvas.clientWidth / scale / 2;
    const hh = canvas.clientHeight / scale / 2;
    const l = centerX - hw, r = centerX + hw, b = centerY - hh, t = centerY + hh;
    const m = new Float32Array(16);
    m[0] = 2 / (r - l);
    m[5] = 2 / (t - b);
    m[10] = -1;
    m[12] = -(r + l) / (r - l);
    m[13] = -(t + b) / (t - b);
    m[15] = 1;

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.uMatrix, false, m);
    gl.uniform4f(this.uColor, color[0], color[1], color[2], color[3]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES, 0, this.count);
    gl.bindVertexArray(null);
  }
}
