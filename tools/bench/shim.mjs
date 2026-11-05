// Bouchons DOM minimaux : pdf.js n'en a besoin que pour démarrer, l'extraction
// de texte ne dessine rien.
class M { constructor(i){ const a=Array.isArray(i)?i:[1,0,0,1,0,0];
  [this.a,this.b,this.c,this.d,this.e,this.f]=a; }
  multiply(){return this;} translate(){return this;} scale(){return this;}
  transformPoint(p){return p;} invertSelf(){return this;} }
globalThis.DOMMatrix ??= M;
globalThis.DOMPoint ??= class { constructor(x=0,y=0){this.x=x;this.y=y;} };
globalThis.Path2D ??= class { moveTo(){} lineTo(){} bezierCurveTo(){} closePath(){} rect(){} addPath(){} quadraticCurveTo(){} };
globalThis.ImageData ??= class { constructor(w,h){this.width=w;this.height=h;} };
