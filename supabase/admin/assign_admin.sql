-- Primero crea la cuenta normalmente desde la web.
-- Sustituye el correo de ejemplo por el correo exacto de esa cuenta y ejecuta esto en Supabase SQL Editor.
insert into public.admin_users (user_id)
select id
from auth.users
where lower(email) = lower('tu-correo@ejemplo.com')
on conflict (user_id) do nothing;

-- Si devuelve "INSERT 0 0", confirma que esa cuenta ya fue creada y que el correo está bien escrito.
