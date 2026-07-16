# Activar cuentas y sincronización en RallyOps

RallyOps ya tiene todo el código listo para tener login (email +
contraseña) y sincronizar los datos entre dispositivos usando
Firebase. Para activarlo hay que hacer 3 cosas: crear el proyecto en
Firebase, pegar su configuración en `firebase-config.js`, y — importante —
alojar la app en una URL en vez de abrir `index.html` haciendo doble
clic. Mientras `firebase-config.js` tenga los valores de ejemplo, la
app sigue funcionando 100% local, sin login, como hasta ahora.

## Por qué hay que alojarla en una URL

Los navegadores (Chrome, Safari, etc.) no dejan que una página abierta
como archivo (`file:///...`) guarde la sesión de un login de forma
confiable. Por eso, para que el login funcione bien, la carpeta
`RallyOps` tiene que servirse desde una URL (`https://...`), no
abrirse haciendo doble clic en `index.html`.

La vamos a alojar gratis con **GitHub Pages** (no hace falta instalar
nada, todo se hace desde el navegador):

1. Creá una cuenta en **https://github.com** (si no tenés una).
2. Arriba a la derecha, tocá el **"+"** → **"New repository"**.
   Ponele de nombre `rallyops`, dejalo en **Public**, y tocá **"Create
   repository"**.
3. Dentro del repo vacío, tocá **"uploading an existing file"** (o
   "Add file" → "Upload files").
4. Arrastrá **todos** los archivos y carpetas de `RallyOps`
   (`index.html`, `app.js`, `firebase-config.js`, etc. — el contenido
   de la carpeta, no la carpeta en sí) a esa página, y tocá **"Commit
   changes"**.
5. Andá a **Settings** (del repo) → **Pages** (menú de la izquierda).
   En "Branch" elegí **main** y carpeta **/ (root)**, tocá **Save**.
6. Esperá 1-2 minutos y recargá esa misma página: va a mostrar la URL
   donde quedó publicada, algo como
   `https://tu-usuario.github.io/rallyops/` — esa es la que vas a
   abrir desde la computadora, el iPhone o el Android.
7. Cada vez que haya que actualizar los archivos, repetís el paso 4
   (subís los archivos nuevos al mismo repo, sobreescribiendo) — o me
   pedís que te arme el paso automático si esto se usa seguido.

## Paso a paso en Firebase

1. Entrá a **https://console.firebase.google.com** con tu cuenta de
   Google y creá un proyecto nuevo (podés llamarlo "RallyOps"). Es
   gratis.

2. Dentro del proyecto, en el menú de la izquierda: **Compilación →
   Authentication → Comenzar**. Andá a la pestaña **"Sign-in method"**
   y habilitá el proveedor **"Correo electrónico/contraseña"**.

3. Todavía en el menú de la izquierda: **Compilación → Firestore
   Database → Crear base de datos**. Elegí cualquier ubicación
   (la más cercana a Argentina) y modo **producción**.

4. Adentro de Firestore, andá a la pestaña **"Reglas"** y reemplazá
   todo el contenido por esto:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /usuarios/{uid}/datos/{docId} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

   Esto hace que cada usuario solo pueda leer y escribir sus propios
   datos — nadie puede ver los de otro. Tocá **"Publicar"**.

5. Andá a **Configuración del proyecto** (el ícono de engranaje,
   arriba a la izquierda) → pestaña **"General"** → bajá hasta
   **"Tus apps"** → tocá el ícono `</>` (Web) → registrá una app
   (el nombre no importa, no hace falta Firebase Hosting en ese
   paso).

6. Te va a mostrar un bloque de código con un objeto `firebaseConfig`
   parecido a este:

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "rallyops-xxxx.firebaseapp.com",
     projectId: "rallyops-xxxx",
     storageBucket: "rallyops-xxxx.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef123456"
   };
   ```

   Copialo entero.

7. Abrí el archivo `firebase-config.js` (está en la misma carpeta que
   `index.html`) y reemplazá el objeto de ejemplo por el que
   copiaste. Guardá el archivo.

8. En Firebase, andá a **Authentication → Settings → Authorized
   domains** y agregá el dominio que te dio GitHub Pages (ej:
   `tu-usuario.github.io`), para que el login lo acepte.

9. Subí `firebase-config.js` actualizado al repo de GitHub (repetí el
   paso 4 de arriba) y abrí la URL de GitHub Pages. Ya debería
   aparecer la pantalla de "Iniciar sesión / Crear cuenta".

## Cómo se guardan los datos

Cada usuario tiene sus datos en Firestore bajo
`usuarios/{su-uid}/datos/{competencias|neumaticos|setups|tramos}`.
Cuando carga algo en un dispositivo, se sincroniza solo (en tiempo
real) a cualquier otro dispositivo donde esté logueado con la misma
cuenta.

El botón de backup (⬇️/⬆️ en el encabezado) sigue funcionando igual:
exporta/importa un JSON con todo, útil como respaldo aparte.
