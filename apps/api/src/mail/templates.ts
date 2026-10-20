/** A rendered letter: subject plus plain-text and HTML bodies. */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Letter {
  subject: string;
  intro: string[];
  link: string;
  action: string;
  outro: string[];
}

function render({ subject, intro, link, action, outro }: Letter): EmailContent {
  const text = [...intro, '', link, '', ...outro].join('\n');
  const href = escapeHtml(link);
  const html = [
    ...intro.map((l) => `<p>${escapeHtml(l)}</p>`),
    `<p><a href="${href}">${escapeHtml(action)}</a></p>`,
    `<p>Если ссылка не открывается, скопируй её в браузер:<br>${href}</p>`,
    ...outro.map((l) => `<p>${escapeHtml(l)}</p>`),
  ].join('\n');
  return { subject, text, html };
}

/** `${origin}/${path}?token=…` */
export function tokenLink(origin: string, path: 'verify' | 'reset', token: string): string {
  return `${origin}/${path}?token=${encodeURIComponent(token)}`;
}

/** Email confirmation letter; `link` is `${PUBLIC_ORIGIN}/verify?token=…`. */
export function verifyEmail(link: string): EmailContent {
  return render({
    subject: 'Подтверди email в rootcamp',
    intro: ['Привет!', 'Чтобы подтвердить адрес и открыть практики, перейди по ссылке:'],
    link,
    action: 'Подтвердить email',
    outro: [
      'Ссылка действует 24 часа и сработает один раз.',
      'Если ты не регистрировался в rootcamp, просто удали это письмо.',
    ],
  });
}

/** Password reset letter; `link` is `${PUBLIC_ORIGIN}/reset?token=…`. */
export function resetEmail(link: string): EmailContent {
  return render({
    subject: 'Сброс пароля в rootcamp',
    intro: ['Привет!', 'Чтобы задать новый пароль, перейди по ссылке:'],
    link,
    action: 'Задать новый пароль',
    outro: [
      'Ссылка действует 1 час и сработает один раз.',
      'Если ты не просил сбросить пароль, просто удали это письмо — пароль не изменится.',
    ],
  });
}
