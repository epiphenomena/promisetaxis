/**
 * Every user-facing string, in one file.
 *
 * Kept separate so the nonprofit's Spanish-speaking staff can revise wording
 * without reading TypeScript — pair this file with the fake-WhatsApp harness
 * and they can see each change rendered immediately.
 *
 * Register note: Copán Ruinas is a small town where usted is the courteous
 * default with strangers. Keep it.
 */

export const copy = {
  customer: {
    greeting:
      "¡Hola! 🛺 Somos el servicio de tuktuk de Copán Ruinas.\n\n" +
      "¿Dónde está usted? Toque el botón para enviar su ubicación.",
    locationRequest: "Toque el botón para enviar su ubicación 📍",
    askZone: "¿Adónde va? Elija la zona:",
    askZoneButton: "Ver zonas",
    askLandmark: (zone: string) => `¿Cuál lugar en ${zone}?`,
    askLandmarkButton: "Ver lugares",
    otherPlaceRow: "Otro lugar…",
    otherPlacePrompt: "Escriba el nombre del lugar adonde va:",
    noMatch:
      "No encontré ese lugar. Intente con otro nombre, o escriba *menu* para ver la lista.",
    confirmMatch: "¿Se refiere a este lugar?",
    assigned: (name: string, tuktukNo: string | null, etaMin: number) =>
      `✅ Su tuktuk va en camino.\n\n` +
      `Conductor: *${name}*${tuktukNo ? ` — tuktuk #${tuktukNo}` : ""}\n` +
      `Llega en aproximadamente *${etaMin} minutos*.`,
    queued: (etaMin: number | null) =>
      etaMin === null
        ? "✅ Anotado. En este momento no hay tuktuks disponibles, pero le avisamos apenas se desocupe uno."
        : `✅ Anotado. Su tuktuk llega en aproximadamente *${etaMin} minutos*. Le avisamos cuando esté cerca.`,
    driverOnWay: (name: string, tuktukNo: string | null) =>
      `🛺 *${name}*${tuktukNo ? ` (tuktuk #${tuktukNo})` : ""} viene por usted ahora.`,
    canceled: "Su solicitud fue cancelada. Escriba cuando necesite un tuktuk. 👋",
    alreadyWaiting:
      "Ya tiene una solicitud activa. Escriba *cancelar* si desea anularla.",
    tripDone: "¡Gracias por viajar con nosotros! 🛺 Que le vaya bien.",
    help:
      "Escriba cualquier mensaje para pedir un tuktuk.\n" +
      "*cancelar* — anula su solicitud\n" +
      "*menu* — empezar de nuevo",
  },

  driver: {
    // The whole driver interface: three buttons, WhatsApp's hard maximum.
    buttons: {
      done: "✅ Listo",
      bandera: "✋ Bandera",
      break: "☕ Descanso",
      resume: "🛺 Disponible",
    },
    idle: "No hay viajes pendientes. Está disponible. 🛺",
    newTrip: (pickup: string, dest: string) =>
      `🛺 *Nuevo viaje*\n\nRecoger en: *${pickup}*\nDestino: *${dest}*`,
    pinCaption: "Ubicación del cliente",
    tripDone: "Viaje completado ✅",
    askBanderaDest: "¿Adónde va el pasajero?",
    banderaZoneButton: "Ver zonas",
    banderaLogged: (dest: string) =>
      `Anotado ✋ → *${dest}*. Toque *${"✅ Listo"}* al terminar.`,
    onBreak: "☕ En descanso. Toque *🛺 Disponible* cuando regrese.",
    finishTripFirst:
      "Primero termine el viaje actual con *✅ Listo*, y después tome su descanso.",
    backAvailable: "🛺 Disponible otra vez. ¡Buen viaje!",
    noActiveTrip: "No tiene ningún viaje activo en este momento.",
    askLocation:
      "Para empezar el turno, envíe su ubicación 📍 así sabemos por dónde anda.",
    locationSaved: (zone: string) => `Anotado: está por *${zone}*. 🛺`,
    notRegistered:
      "Este número no está registrado como conductor. Hable con la oficina.",
    help:
      "*listo* — terminar el viaje actual\n" +
      "*bandera* — pasajero recogido en la calle\n" +
      "*descanso* — tomar un descanso\n" +
      "*disponible* — volver al servicio",
  },

  common: {
    unknown: "No entendí ese mensaje. Escriba *ayuda* para ver las opciones.",
    error: "Hubo un problema. Intente de nuevo en un momento.",
  },
} as const;

/** Keyword aliases, so drivers can type instead of tapping when buttons fail. */
export const driverKeywords: Record<string, "done" | "bandera" | "break" | "resume" | "help"> = {
  listo: "done",
  terminado: "done",
  termine: "done",
  ya: "done",
  bandera: "bandera",
  calle: "bandera",
  descanso: "break",
  comida: "break",
  almuerzo: "break",
  pausa: "break",
  disponible: "resume",
  libre: "resume",
  regrese: "resume",
  ayuda: "help",
};
