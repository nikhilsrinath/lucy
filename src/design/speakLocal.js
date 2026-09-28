import { pickVoice } from '../services/voice';

/* Local speech for things that must not reach the model: the carousel's
   sample line and the onboarding call's greeting. The browser's own
   speechSynthesis — no request, nothing metered. Each persona gets its own
   pitch and rate, which is the whole of what "their voice" means here. */

const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

export function stopSpeaking() {
    if (canSpeak()) window.speechSynthesis.cancel();
}

/** Speaks `text` as `persona`. Returns false when the browser has no voice. */
export function speakSample(persona, text, { onStart, onEnd, onBoundary } = {}) {
    if (!canSpeak() || !text) return false;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(window.speechSynthesis.getVoices());
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-IN';
    u.pitch = persona?.voice?.pitch ?? 1;
    u.rate = persona?.voice?.rate ?? 1;
    u.onstart = () => onStart?.();
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    if (onBoundary) u.onboundary = onBoundary;
    window.speechSynthesis.speak(u);
    return true;
}
