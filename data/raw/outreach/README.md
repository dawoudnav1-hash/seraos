# Outreach event log (read-only extraction)

Generated 2026-11-22. Nothing was sent, drafted, moved, flagged, labelled or deleted. Events are only from messages/records actually seen. Matching rule: counterparty address in prospect_index.json "emails" or its domain in "domains".

## Sources
- Hostinger Mail (dawoud@vertfinance.tech): INBOX.Sent 37 msgs, INBOX 80 msgs, all listed. 31 outbound to prospects became "sent" events (16 Nov 2026 batch of cold emails plus 18 Nov follow-up to Accounting Gurus). Excluded: 2 self-sends to dawoudnav1@gmail.com, a mail to leigh.fernando@thebluerock.com.au (not in prospect index), caitlin@airtree.vc, torquegenius@gmail.com, and a forward to self. 0 of 80 inbound messages came from a prospect address/domain, so 0 replies.
- Gmail (dawoudnav1@gmail.com): all 491 prospect domains queried (20 OR-queries each for `in:sent to:` and `-in:sent from:`). Sent hits: 6 threads (Bassike x2, EQL x2, Step One, Ultraceuticals - the latter bounced with a 550 failure). Inbound hits were only vendor/product mail (Firmable trial, EQL/Halaxy/Simply Wall St/Sapia/ApplyFlow notifications, where the user is the customer or candidate), which are not replies to outreach and were not recorded.
- LinkedIn notification emails in Gmail: first names only appear in subjects; full names come from the sender display name ("X via LinkedIn"). 182 "accepted your invitation" notices exist. I fetched full names for ~50 whose first name matched any prospect first name and recorded exact first+last name matches: 5 connection_accepted (Scott Reid, Tina Grieve CA, Robinson Lovell, Kelan Wright, David Nucifora) and 1 reply (LinkedIn digest "Gabrielle just messaged you" with display name Gabrielle Edmonds, Intrepid Advisory). Domain/email for these comes from the contact sheets.
- Composio LinkedIn (connected as dawoudnav1@gmail.com): exposed tools are only LINKEDIN_LIST_REACTIONS, LINKEDIN_GET_PERSON, LINKEDIN_GET_POST_CONTENT (posting/profile API). No conversation, message, or sent-invitation read tool exists, so 0 events from the API.

## Counts
See the final report / compute from events.json. Date range: 2026-04-14 to 2026-11-22.
- hostinger / email / sent: 31
- gmail / email / sent: 6
- gmail-linkedin-notification / linkedin / connection_accepted: 5
- gmail-linkedin-notification / linkedin / reply: 1
- Total 43. No "opened", "connection_sent", "message_sent", "message_seen" events.

## Not obtainable
- Email opens: no open-tracking notifications (mailtrack/mailsuite/streak/hubspot/"opened your email") exist in Gmail; Hostinger exposes no open data.
- LinkedIn messages/read receipts/sent invitations: the LinkedIn API toolkit cannot read them; seenFlag is null everywhere.
- LinkedIn notification coverage is incomplete: ~130 of the 182 acceptance notices were seen by subject, and only those whose first name matches a prospect first name were checked; older notices and messaging digests with first names only (e.g. "Thanh Nam just messaged you", digests listing several senders) were not resolved. Subject-only matching cannot satisfy exact full-name matching.
- Gmail search previews have no dates; dates for Gmail events came from get_thread. Gmail connection acceptance events are for connections whose notification arrived in Gmail, which is not proof they were the outreach target (name match only).
