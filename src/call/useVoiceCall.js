import { useCallback, useEffect, useRef, useState } from 'react';
import {
    speakable, sentencesOf, pickVoice, tidyTranscript, fillerKind, pickFiller, MAX_SPOKEN_SENTENCES,
} from '../services/voice';

/* ══════════════════════════════════════════════════════════════════════════
   A voice call with the cofounder — the state machine from the old
   VoiceCall.jsx, lifted here unchanged so the call screen can be redrawn:

     listening ─(you pause)→ thinking ─(first sentence)→ speaking ─(done)→ listening

   · Your turn ends ~1s after you stop talking.
   · The answer is asked for short and plain (VOICE_INSTRUCTION, added by
     AssistantContext.send on `voice: true`) and spoken a sentence at a time
     AS IT STREAMS.
   · The microphone is off while the cofounder speaks. Tap the avatar to cut in.
   · Fillers ("Let me pull up the numbers.") cover the wait; heard only.
   · At most MAX_SPOKEN_SENTENCES are read out; the rest is in the chat.
   · Confirming by voice is decided on the server: `confirm_proposal` is
     offered only on voice turns and only for low-risk cards.

   Two additions, both local:
   · `speakerOn` — off, answers are shown and not spoken (what a browser
     without speech synthesis always did).
   · `greeting` — a line said first, with the browser's own voice, before the
     first turn. Never sent to the model, never metered.
   ══════════════════════════════════════════════════════════════════════════ */

const END_AFTER_FINAL_MS = 750;
const END_AFTER_INTERIM_MS = 1200;
const CHARS_PER_SEC = 15.5;
const FILLER_AFTER_MS = 450;
const STILL_AFTER_MS = 4500;

const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

export function useVoiceCall(a, { greeting = '', voiceStyle = null } = {}) {
    const { speech } = a;
    const { supported, finalText, interim, error, levelRef: micLevelRef, heardAtRef, start, stop, reset } = speech;

    const [phase, setPhaseState] = useState(supported ? 'listening' : 'unsupported');
    const phaseRef = useRef(phase);
    const setPhase = useCallback((p) => { phaseRef.current = p; setPhaseState(p); }, []);

    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState('');
    const [spokenTo, setSpokenTo] = useState(0);
    const [trimmed, setTrimmed] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [speakerOn, setSpeakerOnState] = useState(true);
    const speakerRef = useRef(true);

    const levelRef = useRef(0);
    const pulseRef = useRef(0);
    const fillingRef = useRef(false);
    const voiceRef = useRef(null);

    const turnRef = useRef(null);
    const queueRef = useRef([]);
    const speakingRef = useRef(false);
    const genRef = useRef(0);
    const pendingRef = useRef(null);
    const messagesRef = useRef(a.messages);
    messagesRef.current = a.messages;

    const heard = tidyTranscript(`${finalText} ${interim}`);
    const heardRef = useRef('');
    heardRef.current = heard;
    const interimRef = useRef('');
    interimRef.current = interim;

    const voiceOn = () => canSpeak && speakerRef.current;

    /* ── the voice ── */
    useEffect(() => {
        if (!canSpeak) return undefined;
        const load = () => { voiceRef.current = pickVoice(window.speechSynthesis.getVoices()); };
        load();
        window.speechSynthesis.addEventListener?.('voiceschanged', load);
        return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load);
    }, []);

    /* ── listening ── */
    const listen = useCallback(() => {
        if (!supported) return;
        reset();
        heardAtRef.current = Date.now();
        setQuestion('');
        setPhase('listening');
        start();
    }, [supported, reset, start, heardAtRef, setPhase]);

    const clearFillers = useCallback(() => {
        (turnRef.current?.timers || []).forEach(clearTimeout);
    }, []);

    const silenceVoice = useCallback(() => {
        clearFillers();
        genRef.current += 1;
        queueRef.current = [];
        speakingRef.current = false;
        fillingRef.current = false;
        if (canSpeak) window.speechSynthesis.cancel();
    }, [clearFillers]);

    /* ── speaking ── */
    const finishTurn = useCallback(() => {
        clearFillers();
        turnRef.current = null;
        if (!supported) setPhase('unsupported');
        else if (phaseRef.current !== 'paused') listen();
    }, [listen, clearFillers, supported, setPhase]);

    const pump = useCallback(() => {
        if (speakingRef.current || phaseRef.current === 'paused') return;
        const next = queueRef.current.shift();
        if (!next) {
            if (turnRef.current?.done) finishTurn();
            return;
        }
        setPhase('speaking');
        if (!voiceOn()) {
            // No voice (or the speaker is off): show the answer and move on.
            setSpokenTo((n) => Math.max(n, next.end));
            pump();
            return;
        }
        const gen = genRef.current;
        const u = new SpeechSynthesisUtterance(next.text);
        u.voice = voiceRef.current;
        u.lang = voiceRef.current?.lang || 'en-IN';
        u.rate = voiceStyle?.rate ? 1.05 * voiceStyle.rate : 1.05;
        if (voiceStyle?.pitch) u.pitch = voiceStyle.pitch;
        speakingRef.current = true;

        let boundaries = false;
        const t0 = performance.now();
        const est = setInterval(() => {
            if (gen !== genRef.current) { clearInterval(est); return; }
            if (boundaries) return;
            const said = Math.min(next.text.length, ((performance.now() - t0) / 1000) * CHARS_PER_SEC);
            setSpokenTo((n) => Math.max(n, next.start + Math.round(said)));
        }, 90);

        u.onboundary = (e) => {
            if (gen !== genRef.current) return;
            boundaries = true;
            pulseRef.current = 1;
            const to = next.start + e.charIndex + (e.charLength || 0);
            setSpokenTo((n) => Math.max(n, Math.min(next.end, to)));
        };
        const done = () => {
            clearInterval(est);
            if (gen !== genRef.current) return;
            speakingRef.current = false;
            setSpokenTo((n) => Math.max(n, next.end));
            pump();
        };
        u.onend = done;
        u.onerror = done;
        window.speechSynthesis.speak(u);
    }, [finishTurn, setPhase, voiceStyle]);

    // A filler holds the voice like a sentence does; the answer waits for it.
    const sayFiller = useCallback((line) => {
        if (!voiceOn() || phaseRef.current !== 'thinking') return;
        const gen = genRef.current;
        const u = new SpeechSynthesisUtterance(line);
        u.voice = voiceRef.current;
        u.lang = voiceRef.current?.lang || 'en-IN';
        u.rate = 1.0;
        u.pitch = voiceStyle?.pitch ? voiceStyle.pitch * 0.98 : 0.98;
        speakingRef.current = true;
        fillingRef.current = true;
        const done = () => {
            if (gen !== genRef.current) return;
            speakingRef.current = false;
            fillingRef.current = false;
            pump();
        };
        u.onend = done;
        u.onerror = done;
        window.speechSynthesis.speak(u);
    }, [pump, voiceStyle]);

    /* ── asking ── */
    const ask = useCallback((text) => {
        const turn = { known: new Set(messagesRef.current.map((m) => m.id)), queued: 0, done: false, timers: [] };
        turnRef.current = turn;
        setAnswer('');
        setSpokenTo(0);
        setTrimmed(false);
        const kind = fillerKind(text);
        const fill = (line) => () => {
            if (turnRef.current !== turn || turn.queued > 0 || speakingRef.current) return;
            sayFiller(line);
        };
        turn.timers.push(setTimeout(fill(pickFiller(kind)), FILLER_AFTER_MS));
        turn.timers.push(setTimeout(fill(pickFiller('still')), STILL_AFTER_MS));
        a.send(text, { voice: true });
    }, [a, sayFiller]);

    const endTurn = useCallback((text) => {
        stop();
        setQuestion(text);
        setPhase('thinking');
        if (a.streaming) pendingRef.current = text;
        else ask(text);
    }, [a.streaming, ask, stop, setPhase]);

    useEffect(() => {
        if (!a.streaming && pendingRef.current) {
            const text = pendingRef.current;
            pendingRef.current = null;
            ask(text);
        }
    }, [a.streaming, ask]);

    // Start with the call — with the greeting first when there is one;
    // everything is torn down with it.
    useEffect(() => {
        const t0 = Date.now();
        const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
        if (greeting) {
            const text = speakable(greeting);
            turnRef.current = { known: new Set(messagesRef.current.map((m) => m.id)), queued: 0, done: true, timers: [], local: true };
            setAnswer(text);
            queueRef.current.push(...sentencesOf(text, true));
            pump();
        } else if (supported) {
            listen();
        }
        return () => {
            clearInterval(id);
            silenceVoice();
            stop();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Your turn ends when you stop talking.
    useEffect(() => {
        if (phase !== 'listening') return undefined;
        const id = setInterval(() => {
            const text = heardRef.current;
            if (!text) return;
            const wait = interimRef.current ? END_AFTER_INTERIM_MS : END_AFTER_FINAL_MS;
            if (Date.now() - heardAtRef.current > wait) endTurn(text);
        }, 120);
        return () => clearInterval(id);
    }, [phase, endTurn, heardAtRef]);

    // The answer arrives in the chat; queue each sentence as it completes.
    useEffect(() => {
        const turn = turnRef.current;
        if (!turn || turn.local) return;
        const reply = [...a.messages].reverse().find((m) => m.role === 'assistant' && !turn.known.has(m.id));
        if (!reply) return;
        const complete = Boolean(reply.kind || !a.streaming || reply.error);
        const text = speakable(reply.content || '');
        if (!text && complete) { finishTurn(); return; }
        const all = sentencesOf(text, complete);
        const capped = all.length > MAX_SPOKEN_SENTENCES;
        const parts = all.slice(0, MAX_SPOKEN_SENTENCES);
        setAnswer(capped ? text.slice(0, parts[parts.length - 1].end) : text);
        setTrimmed(capped);
        if (parts.length > turn.queued) {
            clearFillers();
            queueRef.current.push(...parts.slice(turn.queued));
            turn.queued = parts.length;
        }
        if (complete || capped) turn.done = true;
        pump();
    }, [a.messages, a.streaming, pump, finishTurn, clearFillers]);

    /* ── controls ── */
    const cutIn = useCallback(() => {
        if (phaseRef.current !== 'speaking' && phaseRef.current !== 'thinking') return;
        silenceVoice();
        turnRef.current = null;
        listen();
    }, [silenceVoice, listen]);

    /** Mute: stops listening (and any voice) until unmuted. */
    const togglePause = useCallback(() => {
        if (phaseRef.current === 'paused') { listen(); return; }
        silenceVoice();
        turnRef.current = null;
        pendingRef.current = null;
        stop();
        setPhase('paused');
    }, [listen, silenceVoice, stop, setPhase]);

    const setSpeakerOn = useCallback((on) => {
        speakerRef.current = on;
        setSpeakerOnState(on);
        if (!on && canSpeak) {
            // Whatever is being said is cut; the words stay on screen.
            genRef.current += 1;
            window.speechSynthesis.cancel();
            speakingRef.current = false;
            fillingRef.current = false;
            setSpokenTo(Number.MAX_SAFE_INTEGER);
            pump();
        }
    }, [pump]);

    /* ── the level: your voice while listening, the cofounder's while speaking ── */
    useEffect(() => {
        let raf = 0;
        const frame = (now) => {
            const p = phaseRef.current;
            const tt = now / 1000;
            let lvl = 0;
            if (p === 'listening') lvl = micLevelRef.current || 0;
            else if (p === 'speaking') {
                pulseRef.current *= 0.9;
                lvl = 0.28 + 0.22 * Math.abs(Math.sin(tt * 7.3)) * Math.abs(Math.sin(tt * 3.1 + 1)) + 0.3 * pulseRef.current;
            } else if (p === 'thinking') {
                lvl = fillingRef.current
                    ? 0.22 + 0.16 * Math.abs(Math.sin(tt * 6.1)) * Math.abs(Math.sin(tt * 2.3 + 1))
                    : 0.1 + 0.06 * Math.sin(tt * 3);
            }
            levelRef.current = lvl;
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [micLevelRef]);

    return {
        phase, supported, error, elapsed, heard, finalText, interim,
        question, answer, spokenTo, trimmed, levelRef,
        speakerOn, setSpeakerOn, togglePause, cutIn,
    };
}
