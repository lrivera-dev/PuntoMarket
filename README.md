# Punto Market — prueba local

Web de prueba para abrir perfiles y catálogos con cuentas reales. La página se ejecuta en tu computadora; Supabase guarda las cuentas y los datos compartidos. Todavía no está publicada.

## Preparación

1. Instala Node.js LTS si aún no está instalado.
2. Crea un proyecto de desarrollo en Supabase.
3. En **SQL Editor**, ejecuta en orden `supabase/migrations/20261114000100_marketplace.sql`, `supabase/migrations/20261114000200_realtime_notices.sql` y `supabase/migrations/20261114000300_partner_product_images.sql` y, al final, `supabase/migrations/20261114000400_realtime_profiles_and_access.sql` y `supabase/migrations/20261114000500_admin_exchange_stats.sql`. La última habilita el panel de administración.
4. En **Project Settings → API**, copia la **Project URL** y la clave pública **Publishable** (o `anon`). No uses la clave `secret` o `service_role` en la web.
5. Copia `.env.example` como `.env` y completa las dos variables.
6. En Supabase Auth, habilita Email y Password y desactiva **Confirm Email** en Authentication → Sign In / Providers → Email. Así cada persona puede crear la cuenta y entrar de inmediato, sin abrir el correo.

## Iniciar la web

```sh
npm install
npm run dev
```

En la computadora, abre la dirección local que imprime Vite. Para probar desde teléfonos, conéctalos a la misma red Wi-Fi y abre `http://IP-DE-TU-COMPUTADORA:5173`. Permite el acceso en el firewall si macOS lo solicita.

Cada participante crea su cuenta con su correo, contraseña y nombre. Para simular varias personas en un solo teléfono, cierra sesión e inicia con otra cuenta. Cada teléfono mantiene su propia sesión.

Sin Confirm Email, Supabase acepta direcciones que no se han comprobado. Para esta prueba de evento es más rápido; antes de abrir el registro al público, decide si conviene volver a activar esa verificación.

## Dar acceso de administración

1. Crea primero tu cuenta normalmente desde la web.
2. En Supabase, abre **SQL Editor** y ejecuta `supabase/admin/assign_admin.sql`, reemplazando `tu-correo@ejemplo.com` por el correo exacto de tu cuenta.
3. Recarga la web o vuelve a iniciar sesión. Aparecerá la pestaña **Admin**.

El panel cuenta cada propuesta aceptada como un intercambio y suma uno a cada perfil participante. Varios objetos dentro de una sola propuesta cuentan como un solo intercambio. Solo una persona añadida a `admin_users` puede consultar estas estadísticas; la web no permite que alguien se asigne ese permiso a sí mismo.

## Permisos implementados

- Los nombres aparecen en el directorio de participantes.
- Los productos se consultan solo si pertenecen a la cuenta activa o si esa persona aceptó la solicitud de acceso al catálogo.
- Las propuestas y sus objetos solo se leen desde las cuentas participantes.
- Aceptar una propuesta mueve todos los objetos elegidos y cierra el acceso entre ambos catálogos.
- Las reglas de Row Level Security están en la migración y protegen las consultas aunque alguien cambie el código del navegador.

Para dejar de probar y publicar, se configurará un proyecto y una URL de producción por separado.
