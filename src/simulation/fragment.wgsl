uniform viewMode: f32;
uniform contours: f32;
uniform waterPass: f32;
uniform clock: f32;
varying vWorld: vec3f;
varying vNormal: vec3f;
varying vData: vec4f;
varying vExtra: vec4f;

fn random(p: vec2f) -> f32 { return fract(sin(dot(p,vec2f(12.9898,78.233)))*43758.5453); }

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let pos=fragmentInputs.vWorld; let normal=normalize(fragmentInputs.vNormal);
  let d=fragmentInputs.vData; let e=fragmentInputs.vExtra;
  let height=e.z; let slope=1.0-normal.y;
  let grain=random(floor(pos.xz*0.6));
  let broad=sin(pos.x*0.012+sin(pos.z*0.014))*sin(pos.z*0.025)*0.5+0.5;
  let green=mix(vec3f(0.29,0.38,0.25),vec3f(0.48,0.52,0.34),broad);
  let rock=mix(vec3f(0.51,0.51,0.43),vec3f(0.66,0.64,0.54),broad);
  let sand=mix(vec3f(0.65,0.59,0.43),vec3f(0.76,0.69,0.53),broad);
  var color=mix(sand,green,smoothstep(48.0,110.0,height));
  color=mix(color,rock,smoothstep(0.12,0.47,slope)*0.85);
  color=mix(color,vec3f(0.77,0.76,0.65),smoothstep(200.0,310.0,height)*0.5);
  color*=0.94+grain*0.12;
  color=mix(color,vec3f(0.29,0.35,0.25),clamp(d.w*0.13,0.0,0.13));
  if(uniforms.viewMode>0.5 && uniforms.viewMode<1.5) {
    let strength=clamp(abs(d.y)/0.4,0.0,1.0);
    color=mix(vec3f(0.52,0.54,0.48),select(vec3f(0.29,0.69,0.70),vec3f(0.87,0.48,0.22),d.y>0),strength);
  }
  if(uniforms.viewMode>1.5 && uniforms.viewMode<2.5) { color=mix(vec3f(0.58,0.59,0.51),vec3f(0.08,0.51,0.70),clamp(d.x/1.5,0.0,1.0)); }
  if(uniforms.viewMode>2.5 && uniforms.viewMode<3.5) { color=mix(vec3f(0.34,0.45,0.51),vec3f(0.91,0.65,0.27),clamp(d.z/3.0,0.0,1.0)); }
  if(uniforms.viewMode>3.5) { color=mix(vec3f(0.72,0.62,0.42),vec3f(0.18,0.49,0.54),d.w); }
  let lighting=0.48+0.52*max(0.0,dot(normal,normalize(vec3f(-0.7,1.3,-0.55))));
  color*=lighting;
  if(uniforms.contours>0.5) {
    let line=abs(fract(height/10.0+0.5)-0.5);
    let width=max(fwidth(height/10.0),0.008);
    color=mix(color,color*0.53,(1.0-smoothstep(0.0,width*1.2,line))*0.6);
  }
  if(e.w<0.0) {
    let strata=0.5+0.5*sin(pos.y*0.2);
    color=mix(vec3f(0.18,0.20,0.17),vec3f(0.32,0.30,0.24),strata)*0.9;
  }
  if(uniforms.waterPass>0.5) {
    if(d.x<0.006 || e.w<0.0) { discard; }
    let wave=sin(pos.x*0.045+pos.z*0.06+uniforms.clock*1.3)*sin(pos.z*0.09-uniforms.clock)*0.05;
    color=mix(vec3f(0.25,0.60,0.60),vec3f(0.10,0.34,0.40),clamp(d.x/4.0,0.0,1.0));
    color+=vec3f(wave);
    color=mix(color,vec3f(0.55,0.49,0.34),clamp(e.y/max(d.x,0.01)*3.0,0.0,0.6));
    fragmentOutputs.color=vec4f(color,clamp(0.45+d.x*0.13,0.45,0.94));
  } else { fragmentOutputs.color=vec4f(color,1.0); }
}
