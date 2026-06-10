'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  /** MP4 com cor (metade de cima) + máscara/alpha (metade de baixo), empilhadas */
  src: string;
  size?: number;
  className?: string;
  /** mostrado se o WebGL/vídeo falhar (ex.: XarloteSwim vetorial) */
  fallback?: ReactNode;
}

const VERT = `
attribute vec2 p;
varying vec2 uv;
void main() {
  uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Vídeo empilhado: cor na metade de cima, matte (alpha) na metade de baixo.
// Com UNPACK_FLIP_Y, cor fica em v∈[0.5,1] e matte em v∈[0,0.5]; um épsilon
// evita sangrar a costura no centro. alpha = vermelho do matte (é cinza).
// Saída PRÉ-MULTIPLICADA (color*a, a): é o que o compositor do canvas espera no
// iOS Safari — sem isso o Safari trata o canvas como opaco (vaza o fundo do vídeo).
const FRAG = `
precision mediump float;
varying vec2 uv;
uniform sampler2D tex;
const float E = 0.0012;
void main() {
  vec3 color = texture2D(tex, vec2(uv.x, mix(0.5 + E, 1.0 - E, uv.y))).rgb;
  float a = texture2D(tex, vec2(uv.x, mix(E, 0.5 - E, uv.y))).r;
  a = smoothstep(0.04, 0.6, a);
  gl_FragColor = vec4(color * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

/**
 * Toca um vídeo com transparência em QUALQUER navegador (Android + iOS): a fonte
 * é um MP4 H.264 comum (cor + máscara empilhadas) e a recomposição RGBA acontece
 * no GPU via WebGL em tempo real. O canvas compõe sobre o fundo aurora do app —
 * o mascote fica recortado, sem moldura. Cai no fallback vetorial se não houver GPU.
 */
export function XarloteVideoAlpha({ src, size = 240, className, fallback }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'auto';
    // src por último: garante que muted/playsInline já estejam setados antes do load
    // (iOS exige isso pra autoplay inline). Mesma origem → sem crossOrigin (evita taint no Safari).
    video.src = src;
    videoRef.current = video;

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    }) as WebGLRenderingContext | null;
    if (!gl) {
      setFailed(true);
      return;
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setFailed(true);
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.clearColor(0, 0, 0, 0);

    let raf = 0;
    let uploaded = false;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (video.readyState < 2) return;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      uploaded = true;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const onError = () => setFailed(true);
    video.addEventListener('error', onError);
    video.play().catch(() => {
      // autoplay pode ser bloqueado; tenta de novo no 1º toque/foco
      const retry = () => video.play().catch(() => {});
      window.addEventListener('pointerdown', retry, { once: true });
    });
    draw();

    // Pausa quando fora da tela (economiza bateria); retoma ao voltar
    const onVis = () => {
      if (document.visibilityState === 'visible') void video.play().catch(() => {});
      else video.pause();
    };
    document.addEventListener('visibilitychange', onVis);

    // Se em ~2.5s nada foi desenhado, assume falha → fallback
    const guard = setTimeout(() => {
      if (!uploaded) setFailed(true);
    }, 2500);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(guard);
      document.removeEventListener('visibilitychange', onVis);
      video.removeEventListener('error', onError);
      video.pause();
      video.src = '';
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, [src]);

  if (failed && fallback) return <>{fallback}</>;

  return (
    <canvas
      ref={canvasRef}
      width={Math.round(size * 2)}
      height={Math.round(size * 2)}
      style={{ width: size, height: size }}
      className={cn('block', className)}
      aria-hidden
    />
  );
}
