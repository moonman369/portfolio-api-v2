# Action node — live

Generated: 2026-10-06T17:15:58.940Z

Real router, real Cal.com link checks, real draft capture and MX lookups, through
`runTurn`. Produced by `scripts/action-eval.js`. **Nothing is sent:** with mail on, the
browser POSTs the payload (Web3Forms refuses server-side calls on its free plan).

**Run with `--memory`:** checkpoints and `mail_events` were in-memory throughout.


## 1. Booking (default config: mail paused)

### 'book a call' → both links + question; then '15' → only the 15-minute link — PASS

**Turn 1** — "book a call" → route `action`, mail `none`

```
You can book a call with Ayan — pick the length that suits you:

- **15 minutes:** https://cal.com/moonman369/15min
- **30 minutes:** https://cal.com/moonman369/30min

Which works better? Click either link, or tell me here.

Pick any open time on the page — I can't see Ayan's calendar from here.
Cal.com shows the open times in your own timezone.
```

**Turn 2** — "15" → route `action`, mail `none`

```
Here's the link to book a 15-minute call with Ayan: https://cal.com/moonman369/15min

Pick any open time on the page — I can't see Ayan's calendar from here.
Cal.com shows the open times in your own timezone.
```

### 'quick 30 min chat' → only the 30-minute link — PASS

**Turn 1** — "can we have a quick 30 min chat?" → route `action`, mail `none`

```
Here's the link to book a 30-minute call with Ayan: https://cal.com/moonman369/30min

Pick any open time on the page — I can't see Ayan's calendar from here.
Cal.com shows the open times in your own timezone.
```

### 'an hour' → only 15 and 30 offered, both shown — PASS

**Turn 1** — "Can I book an hour with Ayan?" → route `action`, mail `none`

```
I can only offer 15- or 30-minute calls, not 60 minutes — here are both:

- **15 minutes:** https://cal.com/moonman369/15min
- **30 minutes:** https://cal.com/moonman369/30min

Which works better? Click either link, or tell me here.

Pick any open time on the page — I can't see Ayan's calendar from here.
Cal.com shows the open times in your own timezone.
```

### a mail request gets the paused reply and the links — PASS

**Turn 1** — "Can you pass a message to Ayan for me?" → route `action`, mail `none`

```
Sending messages isn't available right now, but you can book a 15- or 30-minute call with Ayan instead.

You can book a call with Ayan — pick the length that suits you:

- **15 minutes:** https://cal.com/moonman369/15min
- **30 minutes:** https://cal.com/moonman369/30min

Which works better? Click either link, or tell me here.

Pick any open time on the page — I can't see Ayan's calendar from here.
Cal.com shows the open times in your own timezone.
```

## 2. A broken link (15-minute URL → `https://cal.com/moonman369/action-eval-no-such-event`, this run only)

### 'book a call' with the 15-minute page missing → names it, offers the 30 — PASS

**Turn 1** — "book a call" → route `action`, mail `none`

```
The 15-minute option isn't available right now — its booking page couldn't be found.
You can still book a 30-minute call with Ayan: https://cal.com/moonman369/30min

Pick any open time on the page — I can't see Ayan's calendar from here.
Cal.com shows the open times in your own timezone.
```

### '15 minutes please' with that page missing → says so, offers the other — PASS

**Turn 1** — "can I book 15 minutes with him?" → route `action`, mail `none`

```
The 15-minute meeting you asked for isn't available right now — its booking page couldn't be found.
You can book a 30-minute call with Ayan instead: https://cal.com/moonman369/30min

Pick any open time on the page — I can't see Ayan's calendar from here.
Cal.com shows the open times in your own timezone.
```

## 3. Mail flow, flag switched ON for this graph (Phase 10 code, still guarded)

### full mail flow: ask for an address, confirm, yes — PASS

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

### unreachable address: declined twice, never sent — PASS

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

### a bare 'no' at confirmation cancels — PASS

**Turn 1** — "Please pass a note to Ayan that I enjoyed his portfolio. My email is moonmind.action.eval@gmail.com" → route `action`, mail `confirm`

```
Here's exactly what will be sent:

**To:** Ayan Maiti
**From:** moonmind.action.eval@gmail.com — Ayan can reply to this address
**Subject:** Enjoyed your portfolio

> I enjoyed your portfolio.

Reply **yes** to send it, or **no** to cancel.
```

**Turn 2** — "no" → route `action`, mail `none`

```
Okay — I haven't sent anything. Let me know if you'd like to try again.
```

