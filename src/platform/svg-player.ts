import type { SvgAnimation } from '../core/svg-animation';

export interface SvgPlayback {
  stop(): void;
  pause(): void;
  resume(): void;
  restart(): void;
}

/** Keep the displayed texture intact while decoding the next frame in the other image. */
export function startSvgPlayback(animation: SvgAnimation, canvas: WechatMiniprogram.Canvas,
  source: { width: number; height: number }, isCurrent: () => boolean, onStop: (failed: boolean) => void,
  onReady?: () => void): SvgPlayback {
  const images = [canvas.createImage(), canvas.createImage()];
  let displayed: WechatMiniprogram.Image | undefined;
  const context = canvas.getContext('2d');
  let started = Date.now();
  let running = true;
  let disposed = false;
  let request: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let position = 0;
  let decodeVersion = 0;
  let renderCost = 0;
  let interval = 1000 / 30;
  let nextFrame = started;
  const cancelPending = () => {
    decodeVersion++;
    if (request !== undefined) canvas.cancelAnimationFrame(request);
    request = undefined;
    clearTimeout(timeout);
    for (const image of images) {
      image.onload = () => {};
      image.onerror = () => {};
    }
  };
  const stop = () => {
    if (disposed) return;
    disposed = true; running = false;
    cancelPending();
    for (const image of images) image.src = '';
    canvas.width = 1; canvas.height = 1;
  };
  const fail = () => {
    const notify = !disposed && running && isCurrent();
    stop();
    if (notify) onStop(true);
  };
  const tick = () => {
    request = undefined;
    if (disposed || !running) return;
    if (!isCurrent()) return stop();
    const now = Date.now();
    if (now + 0.5 < nextFrame) {
      request = canvas.requestAnimationFrame(tick);
      return;
    }
    const seconds = Math.min(Math.max(0, (now - started) / 1000), animation.duration);
    const version = ++decodeVersion;
    const image = displayed === images[0] ? images[1] : images[0];
    try {
      // SVG text remains local. Non-ASCII metadata is represented as XML character references.
      const frame = animation.frame(seconds).replace(/[^\x00-\x7f]/gu, char => '&#' + char.codePointAt(0) + ';');
      if (frame.length > 256 * 1024) throw new Error('SVG animation frame exceeds budget');
      const bytes = new Uint8Array(frame.length);
      for (let i = 0; i < frame.length; i++) bytes[i] = frame.charCodeAt(i);
      const failFrame = () => {
        if (version === decodeVersion && running && !disposed) fail();
      };
      timeout = setTimeout(failFrame, 8000);
      image.onerror = failFrame;
      image.onload = () => {
        if (version !== decodeVersion || disposed || !running) return;
        clearTimeout(timeout);
        if (!isCurrent()) return stop();
        const cost = Date.now() - now;
        request = canvas.requestAnimationFrame(() => {
          request = undefined;
          if (version !== decodeVersion || disposed || !running) return;
          if (!isCurrent()) return stop();
          try {
            // Replacing in one operation preserves transparency without exposing a cleared frame.
            context.globalCompositeOperation = 'copy';
            const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
            const width = source.width * scale, height = source.height * scale;
            context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
            const firstFrame = !displayed;
            displayed = image;
            position = seconds;
            if (firstFrame) onReady?.();
            renderCost = renderCost ? renderCost * 0.8 + cost * 0.2 : cost;
            interval = Math.max(1000 / 30, Math.min(1000 / 12, renderCost * 1.5));
            nextFrame = Math.max(nextFrame + interval, Date.now());
            if (seconds >= animation.duration) {
              running = false;
              onStop(false);
            } else request = canvas.requestAnimationFrame(tick);
          } catch { fail(); }
        });
      };
      image.src = 'data:image/svg+xml;base64,' + wx.arrayBufferToBase64(bytes.buffer);
    } catch { fail(); }
  };
  const pause = () => {
    if (disposed || !running) return;
    running = false;
    cancelPending();
  };
  const resume = () => {
    if (disposed || running) return;
    if (position >= animation.duration) position = 0;
    running = true;
    started = Date.now() - position * 1000;
    nextFrame = Date.now();
    tick();
  };
  const restart = () => {
    if (disposed) return;
    pause();
    position = 0;
    resume();
  };
  tick();
  return { stop, pause, resume, restart };
}
