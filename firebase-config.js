// ====================================================
// CONFIGURACIÓN DE FIREBASE
// ====================================================
// Mientras este archivo tenga los valores "PEGAR_AQUI", RallyOps
// funciona 100% local (como hasta ahora, sin cuentas ni sincronización).
//
// Para activar cuentas de usuario + sincronización entre dispositivos:
//   1. Andá a https://console.firebase.google.com y creá un proyecto
//      (es gratis).
//   2. Dentro del proyecto: "Compilación" > "Authentication" >
//      "Comenzar" > pestaña "Sign-in method" > habilitá
//      "Correo electrónico/contraseña".
//   3. Dentro del proyecto: "Compilación" > "Firestore Database" >
//      "Crear base de datos" (modo producción está bien).
//   4. En "Configuración del proyecto" (ícono de engranaje) > pestaña
//      "General" > abajo del todo, "Tus apps" > ícono </> (Web) >
//      registrá una app. Ahí te va a mostrar un objeto como el de
//      abajo: copialo entero y pegalo reemplazando el que sigue.
//
// Después de guardar este archivo, avisale a quien te ayudó a armar
// la app para que termine de configurar las reglas de seguridad.

const firebaseConfig = {
  apiKey: "AIzaSyCniwaOOUdIkpz_db3aR45pq0baEJVlEbw",
  authDomain: "rallyops-ba452.firebaseapp.com",
  projectId: "rallyops-ba452",
  storageBucket: "rallyops-ba452.firebasestorage.app",
  messagingSenderId: "191242017754",
  appId: "1:191242017754:web:06b15e8b8802897cc9fee3"
};
