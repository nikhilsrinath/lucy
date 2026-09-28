/* The intro call's opening line — a template, spoken locally by the browser
   (useVoiceCall's `greeting`), never sent to the model and never metered. */
export function introGreeting(persona, company, extra = '') {
    const who = company ? `${company} is set up` : 'You are set up';
    return `Hi, I'm ${persona.name}, your cofounder. ${who}. ${extra ? `${extra} ` : ''}Ask me anything, or tell me what happened and I'll prepare it for you to confirm.`;
}
