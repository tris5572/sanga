// Conservative four-neighbour finite-volume model. All quantities are SI.
// ground: bedrock elevation / mobile soil thickness / water / suspended sediment.
// hydrology: soil moisture fraction / initial elevation / velocity / simulation time.
// waterLedger: cumulative input / output / infiltration / sediment export (depth).
// earthLedger: uplift rounding remainder / weathering remainder / external sediment / cumulative uplift.
struct Cell { ground: vec4f, hydrology: vec4f, waterLedger: vec4f, earthLedger: vec4f }
struct Flux { water: vec4f, sediment: vec4f, slide: vec4f }
struct Params { grid: vec4f, rain: vec4f, hydro: vec4f, material: vec4f, longterm: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<Cell>;
@group(0) @binding(2) var<storage, read_write> dst: array<Cell>;
@group(0) @binding(3) var<storage, read_write> flux: array<Flux>;
const dirs = array<vec2i,4>(vec2i(-1,0),vec2i(1,0),vec2i(0,-1),vec2i(0,1));
const opposite = array<u32,4>(1u,0u,3u,2u);

fn index(c: vec2i) -> u32 { return u32(c.y)*u32(p.grid.x)+u32(c.x); }

fn inside(c: vec2i) -> bool { return all(c>=vec2i(0)) && all(c<vec2i(i32(p.grid.x))); }

fn sum4(v: vec4f) -> f32 { return dot(v,vec4f(1)); }

@compute @workgroup_size(8,8)
fn sources(@builtin(global_invocation_id) id: vec3u) {
  let n=u32(p.grid.x); if(id.x>=n || id.y>=n) { return; }
  let i=id.y*n+id.x; var c=src[i]; let dt=p.grid.z;
  let period=p.rain.y+p.hydro.x;
  var t=c.hydrology.w;
  if(p.rain.w>0.5) { t=t-floor(t/period)*period; }
  var rain=0.0;
  if(t<p.rain.y) {
    var shape=1.0;
    if(p.rain.z>0.5 && p.rain.z<1.5) { shape=2.0*(1.0-t/p.rain.y); }
    if(p.rain.z>1.5) { shape=2.0*t/p.rain.y; }
    rain=p.rain.x*0.001/p.rain.y*shape*dt;
  }
  // Uniform upstream discharge is distributed over a 94 m inlet.
  let inletWidth=max(3u,u32(round(94.0/p.grid.y)));
  let inletStart=(n-inletWidth)/2u;
  var inflow=0.0; var sediment=0.0;
  if(id.y==0u && id.x>=inletStart && id.x<inletStart+inletWidth) {
    inflow=p.hydro.y*dt/(f32(inletWidth)*p.grid.y*p.grid.y);
    sediment=inflow*p.hydro.z*0.01;
  }
  c.ground.z+=rain+inflow; c.ground.w+=sediment;
  c.waterLedger.x+=rain+inflow; c.earthLedger.z+=sediment;
  let infiltrate=min(c.ground.z,p.hydro.w*0.001/3600.0*(1.0-c.hydrology.x)*dt);
  c.ground.z-=infiltrate; c.waterLedger.z+=infiltrate;
  c.hydrology.x=clamp(c.hydrology.x+infiltrate/0.35-c.hydrology.x*dt/(36.0*3600.0),0.0,1.0);
  // Carry sub-ULP increments so slow uplift/weathering survive f32 rounding.
  let uplift=p.longterm.y*dt/3600.0+c.earthLedger.x;
  let uplifted=c.ground.x+uplift;
  let actualUplift=uplifted-c.ground.x;
  c.earthLedger.x=uplift-actualUplift;
  c.ground.x=uplifted; c.earthLedger.w+=actualUplift;
  let weather=p.longterm.z*0.001*dt/3600.0+c.earthLedger.y;
  let weathered=c.ground.x-weather;
  let actualWeather=c.ground.x-weathered;
  c.earthLedger.y=weather-actualWeather;
  c.ground.x=weathered; c.ground.y+=actualWeather;
  // Only the outlet row is coupled to sea level. Isolated basins stay isolated.
  if(id.y==n-1u) {
    let sea=p.grid.w+p.longterm.x*(c.hydrology.w-p.longterm.w)/3600.0;
    let boundaryDepth=max(0.0,sea-c.ground.x-c.ground.y);
    let exchange=boundaryDepth-c.ground.z;
    if(exchange>0.0) { c.waterLedger.x+=exchange; }
    else {
      c.waterLedger.y-=exchange;
      let exported=c.ground.w*clamp(-exchange/max(c.ground.z,1e-8),0.0,1.0);
      c.ground.w-=exported; c.waterLedger.w+=exported;
    }
    c.ground.z=boundaryDepth;
  }
  c.hydrology.w+=dt;
  dst[i]=c;
}

@compute @workgroup_size(8,8)
fn flows(@builtin(global_invocation_id) id: vec3u) {
  let n=u32(p.grid.x); if(id.x>=n || id.y>=n) { return; }
  let pos=vec2i(id.xy); let i=index(pos); let c=src[i];
  let h=c.ground.x+c.ground.y; let surface=h+c.ground.z;
  var water=vec4f(0); var slide=vec4f(0);
  let friction=0.045+p.material.w*0.09;
  // A fixed small dt, plus a total-outflow limiter, keeps wet/dry fronts positive.
  for(var d=0u; d<4u; d++) {
    let next=pos+dirs[d];
    if(inside(next)) {
      let other=src[index(next)]; let oh=other.ground.x+other.ground.y;
      let slope=max(0.0,(surface-oh-other.ground.z)/p.grid.y);
      let depth=min(c.ground.z,max(0.0,surface-max(h,oh)));
      let velocity=min(12.0,pow(max(depth,0.0),0.666667)*sqrt(slope)/friction);
      water[d]=velocity*depth*p.grid.z/p.grid.y;
      // Moisture lowers the effective stability limit; material moves as soil.
      let stable=tan(p.material.z)*(1.0-c.hydrology.x*0.42);
      slide[d]=max(0.0,h-oh-stable*p.grid.y)*0.018*p.grid.z;
    }
  }
  water*=min(1.0,c.ground.z*0.95/max(sum4(water),1e-12));
  slide*=min(1.0,c.ground.y*0.2/max(sum4(slide),1e-12));
  flux[i].water=water;
  flux[i].sediment=water*c.ground.w/max(c.ground.z,1e-8);
  flux[i].slide=slide;
}

@compute @workgroup_size(8,8)
fn transport(@builtin(global_invocation_id) id: vec3u) {
  let n=u32(p.grid.x); if(id.x>=n || id.y>=n) { return; }
  let pos=vec2i(id.xy); let i=index(pos); var c=src[i]; let f=flux[i];
  var incoming=vec4f(0); var sedimentIn=0.0; var slideIn=0.0;
  var maxSlope=0.0;
  for(var d=0u; d<4u; d++) {
    let next=pos+dirs[d];
    if(inside(next)) {
      let j=index(next); incoming[d]=flux[j].water[opposite[d]];
      sedimentIn+=flux[j].sediment[opposite[d]];
      slideIn+=flux[j].slide[opposite[d]];
      maxSlope=max(maxSlope,(c.ground.x+c.ground.y-src[j].ground.x-src[j].ground.y)/p.grid.y);
    }
  }
  let meanDepth=max(0.005,c.ground.z);
  let vx=(f.water.y-f.water.x+incoming.x-incoming.y)*p.grid.y/(2.0*p.grid.z*meanDepth);
  let vy=(f.water.w-f.water.z+incoming.z-incoming.w)*p.grid.y/(2.0*p.grid.z*meanDepth);
  let speed=min(12.0,length(vec2f(vx,vy)));
  c.ground.z=max(0.0,c.ground.z+sum4(incoming)-sum4(f.water));
  c.ground.w=max(0.0,c.ground.w+sedimentIn-sum4(f.sediment));
  c.ground.y=max(0.0,c.ground.y+slideIn-sum4(f.slide));
  // A single non-cohesive grain class. Coarser grains settle faster and
  // require a higher velocity to entrain. This is a qualitative capacity law.
  let threshold=0.12*sqrt(p.material.y);
  let capacity=0.07*max(0.0,speed-threshold)*sqrt(max(0.0,maxSlope))*c.ground.z;
  if(c.ground.w<capacity && c.ground.z>0.0001) {
    let demand=(capacity-c.ground.w)*p.material.x*(1.0-0.7*p.material.w)*p.grid.z;
    let remainingSoil=max(0.0,c.ground.y-demand);
    let erosion=c.ground.y-remainingSoil;
    c.ground.y=remainingSoil; c.ground.w+=erosion;
    let requestedRock=min(max(0.0,demand-erosion)*0.015,0.0002*p.grid.z);
    let remainingRock=c.ground.x-requestedRock;
    let rock=c.ground.x-remainingRock;
    c.ground.x=remainingRock; c.ground.w+=rock;
  } else {
    let settle=min(1.0,(0.04+sqrt(p.material.y)*0.03)*p.grid.z/max(0.1,c.ground.z));
    let deposit=max(0.0,c.ground.w-capacity)*settle;
    let newSoil=c.ground.y+deposit;
    let actualDeposit=newSoil-c.ground.y;
    if(actualDeposit<=c.ground.w) { c.ground.w-=actualDeposit; c.ground.y=newSoil; }
  }
  c.hydrology.z=speed;
  dst[i]=c;
}
