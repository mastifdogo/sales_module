// Sending mail: through Ledger's shared mailbox (ctx.mail, Ledger ≥ 0.18.3:
// whichever mailbox an admin connected under Settings → Mail, IMAP/SMTP or
// Gmail). Sales' own SMTP settings from before Ledger had a mailbox still
// work for those who chose them, but new setups should use Ledger's.

import { buildMessage, parseAddressList, sendMail } from "../lib/mail.mjs";

export function mailHelpers(ctx, h) {
	/** Validated recipient list from "a@x, b@y". */
	function addresses(v, field, required) {
		try {
			const list = parseAddressList(v);
			if (required && list.length === 0) throw new RangeError("add at least one recipient");
			if (list.length > 20) throw new RangeError("at most 20 addresses");
			return list;
		} catch (e) {
			throw h.bad(`${field}: ${e.message}`);
		}
	}

	async function mailboxStatus() {
		try {
			return await ctx.mail.status();
		} catch {
			return { connected: false, kind: null, account: "", canRead: false, canSend: false };
		}
	}

	/** Whether email can be sent, and if not, what to do about it. */
	async function status(s) {
		if (s.email_via === "smtp") {
			const missing = !s.smtp_host ? "the SMTP server" : !s.from_email ? "the sender address" : "";
			return { via: "smtp", ready: !missing, from: s.from_email, problem: missing ? `Set ${missing} under Settings → Sales.` : "" };
		}
		const g = await mailboxStatus();
		const problem = !g.connected
			? "Ledger's mailbox isn't connected. An admin can connect one under Settings → Mail."
			: !g.canSend
				? "Sales isn't allowed to send mail yet. An admin can allow it under Settings → Mail."
				: "";
		return { via: "mail", ready: g.connected && g.canSend, from: g.account || "", problem };
	}

	async function deliver(s, { to, cc, bcc, subject, text, html, attachments = [] }) {
		const st = await status(s);
		if (!st.ready) throw new ctx.HttpError(409, st.problem);
		const self = s.bcc_self && st.from ? [st.from] : [];
		if (st.via === "mail") {
			const r = await ctx.mail.send({
				to,
				...(cc.length ? { cc } : {}),
				...([...bcc, ...self].length ? { bcc: [...bcc, ...self] } : {}),
				...(s.reply_to ? { replyTo: s.reply_to } : {}),
				subject,
				text,
				...(html ? { html } : {}),
				attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
			});
			return `sent from ${st.from} (message ${r.id})`;
		}
		const msg = buildMessage({ from: s.from_email, fromName: s.from_name || s.business_name, to, cc, bcc: [...bcc, ...self], replyTo: s.reply_to, subject, text, html, attachments });
		const server = { host: s.smtp_host, port: s.smtp_port, security: s.smtp_security, username: s.smtp_username, password: s.smtp_password };
		return sendMail(server, { from: s.from_email, ...msg });
	}

	return { addresses, deliver, status };
}
