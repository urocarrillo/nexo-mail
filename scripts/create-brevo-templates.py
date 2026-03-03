"""
Create Brevo email templates from existing HTML files.
Run once to set up templates, then use template IDs in the drip system.
"""
import json
import os
import re
import urllib.request

API_KEY = os.environ.get("BREVO_API_KEY", "")
API_URL = "https://api.brevo.com/v3/smtp/templates"

TEMPLATES = [
    # EP sequence
    {
        "name": "[Drip] EP - Email 1: Entrega PDF",
        "subject": "Acá tenés los 3 ejercicios para durar más",
        "file": os.path.expanduser("~/Downloads/secuencia-ep/email-ep-1.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "info@urologia.ar",
        "tag": "drip-ep-1",
    },
    {
        "name": "[Drip] EP - Email 2: Valor + ciclo ansiedad",
        "subject": "Lo que nadie te explica sobre acabar rápido",
        "file": os.path.expanduser("~/Downloads/secuencia-ep/email-ep-2.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "info@urologia.ar",
        "tag": "drip-ep-2",
    },
    {
        "name": "[Drip] EP - Email 3: Oferta entrenamiento",
        "subject": "12 módulos para controlar la eyaculación precoz",
        "file": os.path.expanduser("~/Downloads/secuencia-ep/email-ep-3.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "info@urologia.ar",
        "tag": "drip-ep-3",
    },
    # Preservativo sequence
    {
        "name": "[Drip] Preservativo - Email 1: Entrega PDF",
        "subject": "Tu guía para mantener la erección con el preservativo",
        "file": os.path.expanduser("~/Downloads/secuencia-preservativo/email-preservativo-1.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "info@urologia.ar",
        "tag": "drip-preservativo-1",
    },
    {
        "name": "[Drip] Preservativo - Email 2: Ansiedad de desempeño",
        "subject": "Lo que el preservativo te está diciendo",
        "file": os.path.expanduser("~/Downloads/secuencia-preservativo/email-preservativo-2.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "recuperatuereccion@urologia.ar",
        "tag": "drip-preservativo-2",
    },
    {
        "name": "[Drip] Preservativo - Email 3: Curso + Waitlist",
        "subject": "Dos caminos para resolver esto (el que vos elijas)",
        "file": os.path.expanduser("~/Downloads/secuencia-preservativo/email-preservativo-3.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "recuperatuereccion@urologia.ar",
        "tag": "drip-preservativo-3",
    },
    # Waitlist sequence
    {
        "name": "[Drip] Waitlist - Email 1: Confirmación + técnica",
        "subject": "Quedaste anotado — te aviso cuando abra el programa",
        "file": os.path.expanduser("~/Downloads/secuencia-waitlist/email-waitlist-1.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "recuperatuereccion@urologia.ar",
        "tag": "drip-waitlist-1",
    },
    {
        "name": "[Drip] Waitlist - Email 2: Historia + ciclo",
        "subject": "Lo que la mayoría de urólogos no te dice sobre la erección",
        "file": os.path.expanduser("~/Downloads/secuencia-waitlist/email-waitlist-2.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "recuperatuereccion@urologia.ar",
        "tag": "drip-waitlist-2",
    },
    {
        "name": "[Drip] Waitlist - Email 3: Recursos + expectativa",
        "subject": "3 cosas que podés hacer mientras esperás el programa",
        "file": os.path.expanduser("~/Downloads/secuencia-waitlist/email-waitlist-3.html"),
        "sender_name": "Mauro Carrillo",
        "sender_email": "info@urologia.ar",
        "reply_to": "recuperatuereccion@urologia.ar",
        "tag": "drip-waitlist-3",
    },
]


def create_template(tpl):
    with open(tpl["file"], "r", encoding="utf-8") as f:
        html = f.read()

    payload = {
        "templateName": tpl["name"],
        "subject": tpl["subject"],
        "htmlContent": html,
        "sender": {"name": tpl["sender_name"], "email": tpl["sender_email"]},
        "replyTo": tpl["reply_to"],
        "isActive": True,
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=data,
        headers={
            "api-key": API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read().decode())
            return result.get("id")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  ERROR {e.code}: {body}")
        return None


def main():
    if not API_KEY:
        print("Set BREVO_API_KEY environment variable")
        return

    results = {}
    for tpl in TEMPLATES:
        print(f"Creating: {tpl['name']}...")
        template_id = create_template(tpl)
        if template_id:
            print(f"  OK — Template ID: {template_id}")
            results[tpl["tag"]] = template_id
        else:
            print(f"  FAILED")

    print("\n=== TEMPLATE IDS (copy to email-drip.ts) ===")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
