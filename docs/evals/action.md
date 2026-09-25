# Action node — live

Generated: 2026-09-25T08:38:25.446Z

Real router, real draft capture, real MX lookups, through `runTurn`. Produced by
`scripts/action-eval.js`. **Nothing is sent:** the browser POSTs the payload (Web3Forms
refuses server-side calls on its free plan), so delivery is verified from the frontend.

**Run with `--memory`:** checkpoints and `mail_events` were in-memory; routing, capture and MX were live.

**Placeholders used for this run:** WEB3FORMS_ACCESS_KEY, MOONMIND_CALENDLY_URL, MOONMIND_BOOKING_WINDOWS were unset in `.env`.

## book, with a stated preference — PASS

**Turn 1** — "Can I book a call with Ayan on Tuesday afternoon?" → route `action`, mail `none`

```
You can book a call with Ayan here: https://calendly.com/placeholder/30min

Ayan's bookable windows: weekdays 7-10pm IST (placeholder wording)
You mentioned Tuesday afternoon — pick whichever open slot suits you on that page. I can't see his calendar, so I can't promise a particular time is free.

Calendly confirms the booking by email once you pick a slot.
```

## full mail flow: ask for an address, confirm, yes — PASS

**Turn 1** — "send a message to Ayan about a backend role" → route `action`, mail `none`

```
I can pass that on to Ayan. What email address should he reply to?

I only need it so he can get back to you. Nothing is sent until you've seen the message and confirmed it.
```

**Turn 2** — "moonmind.action.eval@gmail.com" → route `action`, mail `confirm`

```
Here's exactly what will be sent:

**To:** Ayan Maiti
**From:** moonmind.action.eval@gmail.com — Ayan can reply to this address
**Subject:** Backend Role Inquiry

> I'd like to talk to you about a backend role.

Reply **yes** to send it, or **no** to cancel.
```

**Turn 3** — "yes" → route `action`, mail `submit`

```
Sending it to Ayan now…
```

Payload the browser would POST:

```json
{
  "access_key": "(redacted)",
  "subject": "Backend Role Inquiry",
  "from_name": "MoonMind — moonmind.action.eval@gmail.com",
  "name": "",
  "email": "moonmind.action.eval@gmail.com",
  "replyto": "moonmind.action.eval@gmail.com",
  "message": "I'd like to talk to you about a backend role."
}
```

## email-first: the address is in the request — PASS

**Turn 1** — "Please pass a note to Ayan that I'd like to discuss a backend role. My email is moonmind.action.eval@gmail.com" → route `action`, mail `confirm`

```
Here's exactly what will be sent:

**To:** Ayan Maiti
**From:** moonmind.action.eval@gmail.com — Ayan can reply to this address
**Subject:** Discussion about a backend role

> I'd like to discuss a backend role.

Reply **yes** to send it, or **no** to cancel.
```

## unreachable address: declined twice, never sent — PASS

**Turn 1** — "send Ayan a message about a backend role" → route `action`, mail `none`

```
I can pass that on to Ayan. What email address should he reply to?

I only need it so he can get back to you. Nothing is sent until you've seen the message and confirmed it.
```

**Turn 2** — "someone@gmial.cmo" → route `action`, mail `none`

```
"someone@gmial.cmo" doesn't look like it can receive email — its domain isn't set up to accept mail, so Ayan wouldn't be able to reply. Could you check it and send it again?
```

**Turn 3** — "someone@gmial.con" → route `action`, mail `none`

```
"someone@gmial.con" doesn't look like it can receive email — its domain isn't set up to accept mail either, so I've stopped here and nothing was sent. You can start again any time by asking me to send Ayan a message.
```

## 'send this to someone@else.com' reaches only the bound inbox — PASS

**Turn 1** — "send this to someone@else.com: I really enjoyed Ayan's portfolio" → route `action`, mail `none`

```
Just so you know: I can only pass messages to Ayan, so this won't go to someone@else.com.

I can pass that on to Ayan. What email address should he reply to?

I only need it so he can get back to you. Nothing is sent until you've seen the message and confirmed it.
```

**Turn 2** — "moonmind.action.eval@gmail.com" → route `action`, mail `confirm`

```
Here's exactly what will be sent:

**To:** Ayan Maiti
**From:** moonmind.action.eval@gmail.com — Ayan can reply to this address
**Subject:** Message from a portfolio visitor

> I really enjoyed Ayan's portfolio.

Reply **yes** to send it, or **no** to cancel.
```

**Turn 3** — "yes" → route `action`, mail `submit`

```
Sending it to Ayan now…
```

Payload the browser would POST:

```json
{
  "access_key": "(redacted)",
  "subject": "Message from a portfolio visitor",
  "from_name": "MoonMind — moonmind.action.eval@gmail.com",
  "name": "",
  "email": "moonmind.action.eval@gmail.com",
  "replyto": "moonmind.action.eval@gmail.com",
  "message": "I really enjoyed Ayan's portfolio."
}
```

## a bare 'no' at confirmation cancels — PASS

**Turn 1** — "Please pass a note to Ayan that I enjoyed his portfolio. My email is moonmind.action.eval@gmail.com" → route `action`, mail `confirm`

```
Here's exactly what will be sent:

**To:** Ayan Maiti
**From:** moonmind.action.eval@gmail.com — Ayan can reply to this address
**Subject:** Feedback on Portfolio

> I enjoyed Ayan's portfolio.

Reply **yes** to send it, or **no** to cancel.
```

**Turn 2** — "no" → route `action`, mail `none`

```
Okay — I haven't sent anything. Let me know if you'd like to try again.
```

