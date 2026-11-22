# Garage Premium Moderno - Hito 3

Un garage digital para guardar autos y motos y consultar orientación de mantenimiento con IA mediante un plan Premium.

## Ejecutar

Requiere Node.js 22 o superior (verificado con 24) y un proyecto Supabase.

1. Abre esta carpeta en VS Code. Ejecuta `npm ci` (`npm.cmd ci` en PowerShell).
2. Copia `.env.example` como `.env`; completa `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY`.
3. En Supabase SQL Editor ejecuta `db/crear.sql` para una base nueva. Si ya aplicaste 001-004, ejecuta solo `supabase/migrations/005_reports_and_premium_delete.sql`. Si falta 004, aplícala antes de 005.
4. Activa **Email** y **Confirm email** en Supabase Auth. Configura el envío de correo, Site URL `http://localhost:3000` y retorno `http://localhost:3000/?auth=callback`.
5. Ejecuta `npm run check`, `npm test` y `npm start`. Abre **http://localhost:3000**.

El método activo es **correo y contraseña con confirmación del correo**. El registro no debe abrir una sesión antes de confirmar. No necesitas configurar proveedores sociales.

Para actualizar, extrae en otra carpeta y conserva tu `.env` y el proyecto anterior. La migración nueva no elimina registros. Las claves secretas de Supabase, Gemini y Mercado Pago se configuran solo en el servidor. Los pagos y la IA se conservaron; necesitan las credenciales de sus servicios y una cuenta Premium para probarlos realmente.

## Documentación

- [Inicio y configuración detallada](00_EMPEZAR_AQUI.md)
- [Informe final del hito 3](docs/INFORME_HITO_3.pdf)
- [Manual de instalación y uso](docs/MANUAL.md)
- [Arquitectura y modelo de datos](docs/ARQUITECTURA.md)
- [Decisiones y correcciones de esta revisión](docs/BITACORA.md)
- [Pruebas realizadas y límites de la verificación](docs/VERIFICACION.md)
- [Preparación de la base de datos](db/README.md)
- [Publicar en Render](PUBLICAR_EN_RENDER.md)

## Entrega académica

Nombre del equipo, integrantes con sus usuarios de GitHub, facultad y ciudad: **completar por el equipo** en el README y en la portada del informe. No se inventaron identidades ni aportes.

Video promocional: **pendiente de agregar por el equipo**. No se crearon videos ni presentaciones. Añade aquí el enlace cuando esté listo.

Se entrega el código para incorporarlo al repositorio existente. El ZIP no sustituye la entrega en GitHub ni acredita un historial de aportes. Conserva el historial real, permite acceso al docente y valida el flujo con tus cuentas antes del cierre del hito.

Actualización: [Reportes guardados y borrado Premium](docs/CAMBIOS_REPORTES_Y_BORRADO.md).
