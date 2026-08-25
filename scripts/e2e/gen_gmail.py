#!/usr/bin/env python3
"""Generate a realistic Gmail Takeout .mbox + Google Calendar .ics for scale
validation: threads with recurring contacts, multipart/alternative HTML,
quoted-printable, RFC2047 subjects, base64 attachments, merchant receipts,
newsletters with List-Unsubscribe, Gmail labels, plus out-of-window old mail."""
import base64
import random
import os
from datetime import datetime, timedelta

random.seed(42)
OUT = os.path.dirname(os.path.abspath(__file__)) + "/e2e-fixtures"
os.makedirs(OUT, exist_ok=True)
SELF = ("Casey Morgan", "casey.morgan.e2e@gmail.com")
PEOPLE = [
    ("Sam Delgado", "sam.delgado@gmail.com"), ("Priya Nair", "priya.nair@outlook.com"),
    ("Jordan Lee", "jordan.lee.work@gmail.com"), ("Alex Fontaine", "alex.fontaine@yahoo.com"),
    ("Mina Park", "mina.park@gmail.com"), ("Tomas Ruiz", "tomas.ruiz@proton.me"),
    ("Grace Obi", "grace.obi@gmail.com"), ("Dev Shah", "dev.shah@company.io"),
    ("Hana Suzuki", "hana.suzuki@gmail.com"), ("Omar Haddad", "omar.haddad@gmail.com"),
] + [(f"Contact {i}", f"contact{i}@example.net") for i in range(20)]
MERCHANTS = [
    ("Amazon.com", "ship-confirm@amazon.com", "Your Amazon.com order has shipped", "Order #{oid}\nOrder Total: ${amt}\nArriving Thursday."),
    ("DoorDash", "no-reply@doordash.com", "Your order receipt", "Thanks for your order!\nTotal charged: ${amt}\nDelivered by dasher."),
    ("Uber Receipts", "noreply@uber.com", "Your Tuesday trip receipt", "Trip fare\nTotal: ${amt}\nThanks for riding."),
    ("Airbnb", "automated@airbnb.com", "Reservation confirmed — {city}", "Confirmation code HM{code}\nTotal: ${amt}\nCheck in Friday."),
]
NEWSLETTERS = [("Morning Brew", "crew@morningbrew.com"), ("The Verge", "newsletters@theverge.com"), ("Strava", "no-reply@strava.com")]
CITIES = ["Pittsburgh", "Tokyo", "Lisbon", "Austin", "Seoul"]
TOPICS = ["dinner Friday", "the Tahoe trip", "apartment hunting", "the demo deck", "pickup basketball", "mom's birthday", "flight options", "that paper", "the offsite", "climbing Saturday"]

now = datetime(2026, 7, 28, 12, 0, 0)
msgs = []

def fmt_date(dt):
    return dt.strftime("%a, %d %b %Y %H:%M:%S +0000")

def fromline_date(dt):
    return dt.strftime("%a %b %d %H:%M:%S +0000 %Y")

def qp(text):
    out = []
    for ch in text:
        b = ch.encode("utf-8")
        if ch in "=\r\n" or ord(ch) > 126:
            out.append("".join(f"={x:02X}" for x in b))
        else:
            out.append(ch)
    return "".join(out)

def make_msg(i, dt, sender, subject, body_plain, labels, extra_headers=None, html=False, attach=False):
    mid = f"<gen-{i}-{int(dt.timestamp())}@mail.gmail.com>"
    lines = [f"From {1000+i}@xxx {fromline_date(dt)}"]
    h = [
        f"Message-ID: {mid}",
        f"Date: {fmt_date(dt)}",
        f"From: {sender[0]} <{sender[1]}>",
        f"To: {SELF[0]} <{SELF[1]}>",
        f"Subject: {subject}",
        f"X-Gmail-Labels: {','.join(labels)}",
        "MIME-Version: 1.0",
    ]
    if extra_headers:
        h += extra_headers
    if attach:
        bnd = f"mixed{i:06d}"
        h.append(f'Content-Type: multipart/mixed; boundary="{bnd}"')
        body = [
            "", f"--{bnd}", "Content-Type: text/plain; charset=UTF-8", "", body_plain,
            f"--{bnd}", 'Content-Type: application/pdf; name="doc.pdf"',
            'Content-Disposition: attachment; filename="doc.pdf"',
            "Content-Transfer-Encoding: base64", "",
        ]
        blob = base64.b64encode(random.randbytes(180000)).decode()
        body += [blob[j:j+76] for j in range(0, len(blob), 76)]
        body += [f"--{bnd}--"]
    elif html:
        bnd = f"alt{i:06d}"
        h.append(f'Content-Type: multipart/alternative; boundary="{bnd}"')
        body = [
            "", f"--{bnd}", "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: quoted-printable", "", qp(body_plain),
            f"--{bnd}", "Content-Type: text/html; charset=UTF-8", "",
            f"<html><body><div><p>{body_plain.replace(chr(10), '</p><p>')}</p></div></body></html>",
            f"--{bnd}--",
        ]
    else:
        h.append("Content-Type: text/plain; charset=UTF-8")
        body = ["", body_plain]
    return "\n".join(lines + h + body).replace("\nFrom ", "\n>From ") + "\n\n"

i = 0
# 1800 personal/thread emails over 13 months (some outside 12mo window)
for _ in range(1800):
    i += 1
    dt = now - timedelta(minutes=random.randint(0, 13 * 30 * 24 * 60))
    p = random.choice(PEOPLE)
    topic = random.choice(TOPICS)
    subj = random.choice([f"Re: {topic}", topic.capitalize(), f"Fwd: {topic}"])
    body = f"Hey {SELF[0].split()[0]},\n\n{random.choice(['Quick thought on', 'Following up on', 'Are we still on for'])} {topic}? {random.choice(['Let me know.', 'Call me later.', 'No rush.'])}\n\nBest,\n{p[0].split()[0]}\nSent from my phone · {random.choice(['(412) 555-01' + str(random.randint(10,99)), ''])}"
    msgs.append(make_msg(i, dt, p, subj, body, ["Inbox"] if random.random() > 0.3 else ["Inbox", "Important"], html=random.random() < 0.5, attach=random.random() < 0.3))

# 120 receipts
for _ in range(120):
    i += 1
    dt = now - timedelta(minutes=random.randint(0, 11 * 30 * 24 * 60))
    name, addr, subj, tmpl = random.choice(MERCHANTS)
    oid = f"{random.randint(100,999)}-{random.randint(1000000,9999999)}-{random.randint(1000000,9999999)}"
    body = tmpl.format(oid=oid, amt=f"{random.uniform(8, 480):.2f}", city=random.choice(CITIES), code=f"{random.randint(10**7, 10**8-1):X}")
    msgs.append(make_msg(i, dt, (name, addr), subj.format(city=random.choice(CITIES)), body, ["Inbox", "Category Updates"], extra_headers=[f"List-Unsubscribe: <mailto:unsub@{addr.split('@')[1]}>"]))

# 380 newsletters (should auto-deselect)
for _ in range(380):
    i += 1
    dt = now - timedelta(minutes=random.randint(0, 11 * 30 * 24 * 60))
    name, addr = random.choice(NEWSLETTERS)
    msgs.append(make_msg(i, dt, (name, addr), f"{name}: {random.choice(TOPICS)} edition", "Today's top stories...\n" * 20, ["Category Promotions"], extra_headers=[f"List-Unsubscribe: <mailto:unsub@{addr.split('@')[1]}>"]))

random.shuffle(msgs)
with open(OUT + "/gmail-takeout.mbox", "w") as f:
    f.write("".join(msgs))

# Calendar: 260 events, attendees overlap email contacts (entity join test)
events = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar//EN"]
for j in range(260):
    dt = now - timedelta(days=random.randint(0, 360), hours=random.randint(-8, 8))
    p = random.choice(PEOPLE[:10])
    topic = random.choice(TOPICS)
    events += [
        "BEGIN:VEVENT", f"UID:evt-gen-{j}@google.com",
        f"DTSTART:{dt.strftime('%Y%m%dT%H%M%SZ')}",
        f"DTEND:{(dt + timedelta(hours=1)).strftime('%Y%m%dT%H%M%SZ')}",
        f"SUMMARY:{topic.capitalize()} with {p[0].split()[0]}",
        f"LOCATION:{random.choice(['Zoom', 'Blue Bottle', 'Office 4F', random.choice(CITIES)])}",
        f"ORGANIZER;CN={SELF[0]}:mailto:{SELF[1]}",
        f"ATTENDEE;CN={p[0]}:mailto:{p[1]}",
        "END:VEVENT",
    ]
events.append("END:VCALENDAR")
with open(OUT + "/gcal-takeout.ics", "w") as f:
    f.write("\r\n".join(events))

sz = os.path.getsize(OUT + "/gmail-takeout.mbox")
print(f"mbox: {len(msgs)} messages, {sz/1e6:.1f} MB · ics: 260 events")
print(f"self: {SELF} · top contact: {PEOPLE[0]}")
