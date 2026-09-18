/**
 * Simple NxN grid mesh generation in display coordinates.
 * 
 * The mesh is a regular grid - all the "warp" comes from the UV coordinates.
 */

export interface GridMesh {
  positions: Float32Array;   // [x, y, z, x, y, z, ...] - z is always 0
  texCoords: Float32Array;   // [u, v, u, v, ...] normalized [0,1]
  indices: Uint32Array;      // Triangle indices
  vertexCount: number;
  triangleCount: number;
}

/**
 * Generate a regular NxN grid of triangles.
 * 
 * @param bounds [minX, minY, maxX, maxY] in display CRS
 * @param gridSize Number of cells across (e.g., 16 = 16x16 grid = 512 triangles)
 * @param gridRows Number of cells down; defaults to gridSize (square grid)
 */
export function generateGridMesh(
  bounds: [number, number, number, number],
  gridSize: number = 16,
  gridRows: number = gridSize
): GridMesh {
  const [minX, minY, maxX, maxY] = bounds;
  const cols = gridSize;
  const rows = gridRows;
  const numVertices = (cols + 1) * (rows + 1);
  const numTriangles = cols * rows * 2;

  // deck.gl SimpleMeshLayer wants xyz positions
  const positions = new Float32Array(numVertices * 3);
  const texCoords = new Float32Array(numVertices * 2);
  const indices = new Uint32Array(numTriangles * 3);

  // Generate vertices
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const vertIdx = j * (cols + 1) + i;
      const u = i / cols;
      const v = j / rows;
      
      // Position in display CRS (z = 0)
      positions[vertIdx * 3 + 0] = minX + u * (maxX - minX);
      positions[vertIdx * 3 + 1] = minY + v * (maxY - minY);
      positions[vertIdx * 3 + 2] = 0;
      
      // Default UV (identity - will be overwritten by projection logic)
      texCoords[vertIdx * 2 + 0] = u;
      texCoords[vertIdx * 2 + 1] = v;
    }
  }

  // Generate triangle indices (two triangles per grid cell)
  let triIdx = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const topLeft = j * (cols + 1) + i;
      const topRight = topLeft + 1;
      const bottomLeft = (j + 1) * (cols + 1) + i;
      const bottomRight = bottomLeft + 1;

      // First triangle
      indices[triIdx++] = topLeft;
      indices[triIdx++] = bottomLeft;
      indices[triIdx++] = topRight;

      // Second triangle
      indices[triIdx++] = topRight;
      indices[triIdx++] = bottomLeft;
      indices[triIdx++] = bottomRight;
    }
  }

  return { 
    positions, 
    texCoords, 
    indices,
    vertexCount: numVertices,
    triangleCount: numTriangles
  };
}
