struct Cell { ground: vec4f, hydrology: vec4f, waterLedger: vec4f, earthLedger: vec4f }
var<storage,read> state: array<Cell>;
uniform worldViewProjection: mat4x4f;
uniform gridSize: f32;
uniform exaggeration: f32;
uniform waterPass: f32;
attribute position: vec3f;
varying vWorld: vec3f;
varying vNormal: vec3f;
varying vData: vec4f;
varying vExtra: vec4f;

fn h(c: vec2i) -> f32 {
  let n=i32(uniforms.gridSize);
  let xy=clamp(c,vec2i(0),vec2i(n-1));
  let s=state[u32(xy.y*n+xy.x)].ground;
  return (s.x+s.y+select(0.0,s.z,uniforms.waterPass>0.5))*uniforms.exaggeration;
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let n=i32(uniforms.gridSize);
  let xy=vec2i(round((vertexInputs.position.xz/2400.0+0.5)*f32(n-1)));
  let c=state[u32(xy.y*n+xy.x)];
  var height=h(xy);
  if(vertexInputs.position.y< -0.5) { height=-28.0; }
  let waterOffset=select(0.0,0.12,uniforms.waterPass>0.5);
  let pos=vec3f(vertexInputs.position.x,height+waterOffset,vertexInputs.position.z);
  let dx=2400.0/f32(n-1);
  let normal=normalize(vec3f(h(xy+vec2i(-1,0))-h(xy+vec2i(1,0)),2.0*dx,h(xy+vec2i(0,-1))-h(xy+vec2i(0,1))));
  vertexOutputs.position=uniforms.worldViewProjection*vec4f(pos,1);
  vertexOutputs.vWorld=pos;
  vertexOutputs.vNormal=normal;
  vertexOutputs.vData=vec4f(c.ground.z,c.ground.x+c.ground.y-c.hydrology.y,c.hydrology.z,c.hydrology.x);
  vertexOutputs.vExtra=vec4f(c.ground.y,c.ground.w,c.ground.x+c.ground.y,vertexInputs.position.y);
}
