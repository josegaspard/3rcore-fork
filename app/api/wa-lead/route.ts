import { NextResponse } from 'next/server';
import { readAttribution } from '@/lib/attribution';
import { postLeadToPanel } from '@/lib/panel-lead';
import { guardarEnCrm } from '@/lib/crm-lead';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Captura PROPIA de WhatsApp (recursos propios, sin terceros tipo Cliengo):
// guarda el lead en el panel CRM ANTES de abrir el chat, para que /panel
// reciba los datos (nombre + celular + servicio) y no queden filas vacías.
// El token del panel queda en el servidor, no se expone en el navegador.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { nombre, celular, proyecto, servicio, origin, gclid, sitio_web, consentimiento_publicidad, email, empresa, web, consulta } = body;
    if (!nombre || !celular) {
      return NextResponse.json({ ok: false, error: 'name_and_phone_required' }, { status: 400 });
    }
    // Honeypot: campo invisible para personas. Si viene lleno es un bot — se
    // responde OK para no darle señal de que fue detectado, pero el lead NO
    // entra al CRM. Mismo patrón que /api/contact.
    if (sitio_web) {
      return NextResponse.json({ ok: true });
    }
    // Un celular sin dígitos suficientes suele ser basura automatizada: el panel
    // se llenaba de filas inútiles que además contaban como conversión.
    // 23-nov-2026: pero una PERSONA que escribe el celular incompleto también
    // caía aquí y se perdía en silencio (el modal le abría WhatsApp igual, así
    // que le escribía a 3R Core y no salía en el panel; pasó el 20-nov). Si la
    // petición trae la visita propia del sitio (cookie r3_sid, que un bot que
    // llama a la API directo no tiene), se guarda marcada para buscarla en
    // WhatsApp por nombre y hora. Sin visita, se sigue descartando.
    const digitos = String(celular).replace(/\D/g, '');
    const celularValido = digitos.length >= 7 && digitos.length <= 15;
    const visitaReal = /(?:^|;\s*)r3_sid=[A-Za-z0-9]{8,64}/.test(request.headers.get('cookie') || '');
    if (!celularValido && !visitaReal) {
      return NextResponse.json({ ok: true });
    }
    const avisoCelular = celularValido
      ? null
      : `Celular incompleto: «${String(celular).slice(0, 40)}» (búscalo en WhatsApp por nombre y hora)`;
    // El GCLID va en su propia línea para poder exportar conversiones offline a
    // Google Ads (subir gclid + fecha/hora de conversión cuando el lead cierre).
    const mensaje = [
      avisoCelular,
      // Los demás captadores (PillarWaCapture, landing…) mandan solo `proyecto`
      // y es su servicio; el modal global manda `servicio` + consulta aparte.
      servicio ? `Servicio: ${servicio}` : proyecto ? `Servicio: ${proyecto}` : null,
      servicio && proyecto ? `Consulta: ${proyecto}` : null,
      // Formularios largos (home, /nosotros): web y mensaje de la persona.
      web ? `Web: ${String(web).slice(0, 200)}` : null,
      consulta ? `Mensaje: ${String(consulta).slice(0, 2000)}` : null,
      gclid ? `GCLID: ${gclid}` : null,
      origin ? `Origen: ${origin}` : null,
    ].filter(Boolean).join('\n');

    // Solo cuenta si el panel confirmó con JSON ok:true (ver lib/panel-lead.ts).
    const [ok] = await Promise.all([postLeadToPanel({
      nombre,
      telefono: celular,
      email: typeof email === 'string' ? email.trim().slice(0, 200) : '',
      apellido: typeof empresa === 'string' ? empresa.trim().slice(0, 120) : '',
      mensaje,
      // La fuente refleja la página real de origen (el widget también vive
      // en /posicionamiento-seo y otras páginas, no solo en la landing).
      website: origin ? `WhatsApp ${origin}` : 'WhatsApp /performance-marketing',
      attribution: readAttribution(request, 'wa-lead'),
      // Casilla opcional de comunicaciones por correo (Ley 28493/29733):
      // true solo si la persona la marcó.
      consentimiento_publicidad: consentimiento_publicidad === true,
    }),
      // CRM propio (crm.3rcore.com, MySQL), en paralelo con el panel anterior.
      guardarEnCrm(request, 'whatsapp', {
        formulario: origin ? `WhatsApp ${origin}` : 'WhatsApp',
        nombre,
        telefono: celular,
        email: typeof email === 'string' ? email : undefined,
        empresa: typeof empresa === 'string' ? empresa : undefined,
        servicio: servicio || proyecto,
        mensaje: [avisoCelular, servicio && proyecto ? `Consulta: ${proyecto}` : null, web ? `Web: ${web}` : null, consulta || null]
          .filter(Boolean).join('\n') || undefined,
        consentimiento_publicidad: consentimiento_publicidad === true,
      }, body),
    ]);
    if (!ok) console.error('LEAD DE WHATSAPP SIN GUARDAR EN EL PANEL', origin);
    return NextResponse.json({ ok });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
