import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAssistant } from '../components/assistant/assistantStore';
import { documentStore } from '../services/documentStore';
import { notificationTarget } from '../shell/notifications';

/* What tapping a brief figure or suggestion does — shared by Home and Buddy,
   so the same card behaves the same wherever it is shown. `ask` sends a
   message, which always happens in the chat (Buddy). */
export function useBriefActions({ build }) {
    const a = useAssistant();
    const navigate = useNavigate();
    const { pathname } = useLocation();

    const ask = useCallback((text) => {
        if (!pathname.startsWith('/chat')) navigate('/chat');
        a.send(text);
    }, [a, navigate, pathname]);

    const onKpi = useCallback((k) => { if (k.ask) ask(k.ask); else if (k.to) navigate(k.to); }, [ask, navigate]);

    const onSuggestion = useCallback((s) => {
        if (s.build) { build?.(); return; }
        if (s.notification) {
            const to = notificationTarget(s.notification);
            documentStore.deleteNotification(s.notification.id);
            if (to) navigate(to);
            return;
        }
        // An overdue invoice opens it, where Send reminder lives.
        if (s.doc) { navigate(`/money/invoices?doc=${s.doc}`); return; }
        if (s.to) navigate(s.to);
    }, [build, navigate]);

    return { ask, onKpi, onSuggestion };
}
