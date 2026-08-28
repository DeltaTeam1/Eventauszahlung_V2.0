const EVENT_PARTICIPANTS_API_URL = "https://worker.statescloud.de/api/v1/data/event-participants.json?key=fmk_EQyxibxpvsjCeJKVjkr23K1aB34M6_6j&fields=memberName,member.status,note,member.field.passId,eventTitle,member.discordId,eventLogId,eventStartsAt&dateFormat=sheets&tz=Europe/Berlin";
const PARTICIPATION_PAYOUT = 5000;
const PERSON_BONUS = 500;
const API_PAGE_SIZE = 1000;
const BERLIN_TIME_ZONE = "Europe/Berlin";
const ACTIVE_MEMBER_STATUS = "active";
const GOTA_PASSWORD_HASH = "0b155a8e953642f2ef3e82781ad19b6b128ea5e77cbd2f841053c46d36529bd4";

const participantBody = document.querySelector("#participant-body");
const participantTemplate = document.querySelector("#participant-template");
const emptyState = document.querySelector("#empty-state");
const emptyStateCopy = document.querySelector("#empty-state-copy");
const participantSearch = document.querySelector("#participant-search");
const tableFeedback = document.querySelector("#table-feedback");
const dataSourceState = document.querySelector("#data-source-state");
const dataSourceCopy = document.querySelector("#data-source-copy");
const sourceStatus = document.querySelector("#source-status");
const refreshButton = document.querySelector("#refresh-data");
const gotaTrigger = document.querySelector("#gota-trigger");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const gotaPassword = document.querySelector("#gota-password");
const authFeedback = document.querySelector("#auth-feedback");
const dailySection = document.querySelector("#gota-section");
const dailyDate = document.querySelector("#daily-date");
const dailyDateHeading = document.querySelector("#daily-date-heading");
const dailyEventBody = document.querySelector("#daily-event-body");
const dailyEventTemplate = document.querySelector("#daily-event-template");
const dailyEmptyState = document.querySelector("#daily-empty-state");
const dailyEmptyStateCopy = document.querySelector("#daily-empty-state-copy");
const dailyEventCount = document.querySelector("#daily-event-count");
const dailyParticipantCount = document.querySelector("#daily-participant-count");
const dailyTotal = document.querySelector("#daily-total");
const expoButton = document.querySelector("#expo-button");
const expoOutput = document.querySelector("#expo-output");
const expoFeedback = document.querySelector("#expo-feedback");

let earnings = [];
let eventCount = 0;
let attendanceCount = 0;
let totalPayout = 0;
let isLoading = false;
let allParticipantRows = [];
let dailyReports = [];
let isGotaAuthorized = false;

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatNumber(value) {
  return new Intl.NumberFormat("de-DE").format(value);
}

function getText(value) {
  return String(value ?? "").trim();
}

function getBerlinDateKey() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const dateParts = Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));

  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

function formatDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-");
  return `${day}.${month}.${year}`;
}

function isOnOrAfterReportStart(row, reportStartDate) {
  const eventDate = getText(row.eventStartsAt).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(eventDate) && eventDate >= reportStartDate;
}

function getEventDateKey(eventStartsAt) {
  const eventDate = getText(eventStartsAt).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : "";
}

function formatEventStart(eventStartsAt) {
  const value = getText(eventStartsAt);
  const dateKey = getEventDateKey(value);
  const time = value.slice(11, 16);
  return dateKey && /^\d{2}:\d{2}$/.test(time) ? `${formatDateKey(dateKey)} · ${time}` : "--";
}

function formatDailyHeading(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "UTC",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date).replace(",", "");
}

async function hashValue(value) {
  if (!window.crypto?.subtle) {
    throw new Error("Die Browser-Verschluesselung ist nicht verfuegbar.");
  }

  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function setDataSourceState(state, copy, isError = false) {
  dataSourceState.textContent = `DATENQUELLE: ${state}`;
  dataSourceCopy.textContent = copy;
  dataSourceState.classList.toggle("source-error", isError);
}

function setSourceStatus(label, isError = false) {
  sourceStatus.textContent = label;
  sourceStatus.parentElement.classList.toggle("status-error", isError);
}

function setLoading(loading) {
  isLoading = loading;
  refreshButton.disabled = loading;
  refreshButton.classList.toggle("is-loading", loading);
}

function normalizeParticipant(row) {
  const memberStatus = getText(row["member.status"]).toLowerCase();
  const name = getText(row.memberName) || "Unbekannt";
  const passId = getText(row["member.field.passId"]);
  const discordId = getText(row["member.discordId"]);
  const eventLogId = getText(row.eventLogId);
  const eventTitle = getText(row.eventTitle) || "Ohne Eventtitel";
  const eventStartsAt = getText(row.eventStartsAt);

  if (memberStatus !== ACTIVE_MEMBER_STATUS || !eventLogId || (!discordId && !passId && name === "Unbekannt")) {
    return null;
  }

  const identity = discordId
    ? `discord:${discordId}`
    : passId
      ? `pass:${passId}`
      : `name:${name.toLocaleLowerCase("de-DE")}`;

  return { identity, name, passId, discordId, eventLogId, eventTitle, eventStartsAt };
}

function groupEventsByLogId(rows) {
  const eventsByLogId = new Map();

  rows.forEach((row) => {
    const participant = normalizeParticipant(row);
    if (!participant) {
      return;
    }

    let event = eventsByLogId.get(participant.eventLogId);
    if (!event) {
      event = {
        id: participant.eventLogId,
        title: participant.eventTitle,
        startsAt: participant.eventStartsAt,
        participants: new Map(),
      };
      eventsByLogId.set(participant.eventLogId, event);
    }

    if (!event.startsAt && participant.eventStartsAt) {
      event.startsAt = participant.eventStartsAt;
    }

    if (!event.participants.has(participant.identity)) {
      event.participants.set(participant.identity, participant);
    }
  });

  return eventsByLogId;
}

function calculateEventPayout(event) {
  const participantCount = event.participants.size;
  const bonusAmount = participantCount * PERSON_BONUS;
  const payoutPerParticipant = PARTICIPATION_PAYOUT + bonusAmount;

  return {
    participantCount,
    bonusAmount,
    payoutPerParticipant,
    total: payoutPerParticipant * participantCount,
  };
}

function buildEarnings(rows) {
  const eventsByLogId = groupEventsByLogId(rows);
  const peopleByIdentity = new Map();
  let calculatedTotal = 0;

  eventsByLogId.forEach((event) => {
    const payout = calculateEventPayout(event);

    event.participants.forEach((participant) => {
      let person = peopleByIdentity.get(participant.identity);
      if (!person) {
        person = {
          name: participant.name,
          passId: participant.passId,
          discordId: participant.discordId,
          events: [],
          participationAmount: 0,
          bonusAmount: 0,
          total: 0,
        };
        peopleByIdentity.set(participant.identity, person);
      }

      if (!person.passId && participant.passId) {
        person.passId = participant.passId;
      }

      person.events.push({
        id: event.id,
        title: event.title,
        startsAt: event.startsAt,
        participantCount: payout.participantCount,
      });
      person.participationAmount += PARTICIPATION_PAYOUT;
      person.bonusAmount += payout.bonusAmount;
      person.total += payout.payoutPerParticipant;
    });

    calculatedTotal += payout.total;
  });

  const people = [...peopleByIdentity.values()]
    .map((person) => ({
      ...person,
      eventTitles: [...new Set(person.events.map((event) => event.title))],
    }))
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name, "de"));

  return {
    people,
    eventCount: eventsByLogId.size,
    attendanceCount: [...eventsByLogId.values()].reduce((total, event) => total + event.participants.size, 0),
    totalPayout: calculatedTotal,
  };
}

function buildDailyReports(rows) {
  const reportsByDate = new Map();

  groupEventsByLogId(rows).forEach((event) => {
    const dateKey = getEventDateKey(event.startsAt);
    if (!dateKey) {
      return;
    }

    let report = reportsByDate.get(dateKey);
    if (!report) {
      report = {
        dateKey,
        events: [],
        peopleByIdentity: new Map(),
        total: 0,
      };
      reportsByDate.set(dateKey, report);
    }

    const payout = calculateEventPayout(event);
    const dailyEvent = {
      id: event.id,
      title: event.title,
      startsAt: event.startsAt,
      participantCount: payout.participantCount,
      payoutPerParticipant: payout.payoutPerParticipant,
      total: payout.total,
    };

    report.events.push(dailyEvent);
    report.total += payout.total;

    event.participants.forEach((participant) => {
      let person = report.peopleByIdentity.get(participant.identity);
      if (!person) {
        person = {
          name: participant.name,
          discordId: participant.discordId,
          total: 0,
          events: [],
        };
        report.peopleByIdentity.set(participant.identity, person);
      }

      person.total += payout.payoutPerParticipant;
      person.events.push(dailyEvent);
    });
  });

  return [...reportsByDate.values()]
    .map((report) => ({
      dateKey: report.dateKey,
      events: report.events.sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
      people: [...report.peopleByIdentity.values()]
        .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name, "de")),
      participantCount: report.peopleByIdentity.size,
      total: report.total,
    }))
    .sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}

function buildExpoTemplate(report) {
  const participantLines = report.people.map((person) => {
    const recipient = person.discordId
      ? `<@${person.discordId}>`
      : `${person.name} (keine Discord-ID)`;
    return `> ${recipient} - ${formatCurrency(person.total)}`;
  });

  return [
    "## --------------------------",
    "# Eventauszahlung",
    `### ${formatDailyHeading(report.dateKey)}`,
    "",
    `\`\`\`Gesamtauszahlung für den Tag: ${formatCurrency(report.total)}\`\`\``,
    "",
    "**Teilnehmer:**",
    "",
    ...participantLines,
  ].join("\n");
}

function getSearchText(person) {
  return [
    person.name,
    person.passId,
    person.discordId,
    ...person.events.flatMap((event) => [event.title, event.startsAt]),
  ]
    .join(" ")
    .toLocaleLowerCase("de-DE");
}

function updateMetrics() {
  document.querySelector("#participant-count").textContent = formatNumber(earnings.length);
  document.querySelector("#event-count").textContent = formatNumber(eventCount);
  document.querySelector("#total-payout").textContent = formatCurrency(totalPayout);
  document.querySelector("#sidebar-count").textContent = formatNumber(earnings.length);
  document.querySelector("#sidebar-event-count").textContent = formatNumber(eventCount);
}

function renderParticipants() {
  const searchTerm = participantSearch.value.trim().toLocaleLowerCase("de-DE");
  const visibleEarnings = searchTerm
    ? earnings.filter((person) => getSearchText(person).includes(searchTerm))
    : earnings;

  participantBody.replaceChildren();
  emptyState.hidden = visibleEarnings.length > 0;

  visibleEarnings.forEach((person) => {
    const row = participantTemplate.content.cloneNode(true);
    row.querySelector(".participant-name").textContent = person.name;
    row.querySelector(".participant-discord").textContent = person.discordId ? `DISCORD ${person.discordId}` : "DISCORD --";
    row.querySelector(".participant-pass-id").textContent = person.passId || "--";
    row.querySelector(".participant-event-count").textContent = `${formatNumber(person.events.length)} EVENTS`;
    row.querySelector(".participant-event-titles").textContent = person.events
      .map((event) => `${event.title} · ${formatEventStart(event.startsAt)}`)
      .join(", ");
    row.querySelector(".participant-base").textContent = formatCurrency(person.participationAmount);
    row.querySelector(".participant-bonus").textContent = formatCurrency(person.bonusAmount);
    row.querySelector(".participant-total").textContent = formatCurrency(person.total);
    participantBody.append(row);
  });

  updateMetrics();
}

function setFeedback(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function getSelectedDailyReport() {
  return dailyReports.find((report) => report.dateKey === dailyDate.value) ?? null;
}

function populateDailyDateSelect() {
  const previousDate = dailyDate.value;
  dailyDate.replaceChildren();

  if (dailyReports.length === 0) {
    dailyDate.add(new Option("Keine Eventtage vorhanden", ""));
    dailyDate.disabled = true;
    return;
  }

  dailyReports.forEach((report) => {
    dailyDate.add(new Option(formatDailyHeading(report.dateKey), report.dateKey));
  });
  dailyDate.disabled = false;

  const today = getBerlinDateKey();
  const hasPreviousDate = dailyReports.some((report) => report.dateKey === previousDate);
  const hasToday = dailyReports.some((report) => report.dateKey === today);
  dailyDate.value = hasPreviousDate ? previousDate : hasToday ? today : dailyReports[0].dateKey;
}

function renderDailyView() {
  if (!isGotaAuthorized) {
    return;
  }

  const report = getSelectedDailyReport();
  dailyEventBody.replaceChildren();
  dailyEmptyState.hidden = Boolean(report);

  if (!report) {
    dailyDateHeading.textContent = "Keine Tagesdaten";
    dailyEventCount.textContent = "0";
    dailyParticipantCount.textContent = "0";
    dailyTotal.textContent = "$0";
    dailyEmptyStateCopy.textContent = "Fuer den ausgewaehlten Tag liegen keine Events vor.";
    expoOutput.value = "";
    expoButton.disabled = true;
    return;
  }

  dailyDateHeading.textContent = formatDailyHeading(report.dateKey);
  dailyEventCount.textContent = formatNumber(report.events.length);
  dailyParticipantCount.textContent = formatNumber(report.participantCount);
  dailyTotal.textContent = formatCurrency(report.total);
  dailyEmptyStateCopy.textContent = "Keine Events fuer diesen Tag gefunden.";

  report.events.forEach((event) => {
    const row = dailyEventTemplate.content.cloneNode(true);
    row.querySelector(".daily-event-start").textContent = formatEventStart(event.startsAt);
    row.querySelector(".daily-event-title").textContent = event.title;
    row.querySelector(".daily-event-participants").textContent = formatNumber(event.participantCount);
    row.querySelector(".daily-event-payout").textContent = formatCurrency(event.payoutPerParticipant);
    row.querySelector(".daily-event-total").textContent = formatCurrency(event.total);
    dailyEventBody.append(row);
  });

  expoOutput.value = buildExpoTemplate(report);
  expoButton.disabled = false;
}

function setGotaAuthorization(authorized) {
  isGotaAuthorized = authorized;
  dailySection.hidden = !authorized;
  gotaTrigger.querySelector("span").textContent = authorized ? "GOTA AKTIV" : "GOTA-ZUGANG";
  gotaTrigger.title = authorized ? "GOTA-Zugang beenden" : "GOTA-Zugang";
  gotaTrigger.setAttribute("aria-label", gotaTrigger.title);

  if (authorized) {
    populateDailyDateSelect();
    renderDailyView();
  } else {
    expoOutput.value = "";
    expoFeedback.textContent = "";
  }
}

async function authorizeGota(event) {
  event.preventDefault();
  setFeedback(authFeedback, "Zugang wird geprueft ...");

  try {
    const enteredHash = await hashValue(gotaPassword.value);
    if (enteredHash !== GOTA_PASSWORD_HASH) {
      throw new Error("Zugangscode ist ungueltig.");
    }

    gotaPassword.value = "";
    authDialog.close();
    setGotaAuthorization(true);
  } catch (error) {
    setFeedback(authFeedback, error instanceof Error ? error.message : "Zugang konnte nicht geprueft werden.", true);
    gotaPassword.select();
  }
}

async function createAndCopyExpo() {
  const report = getSelectedDailyReport();
  if (!report) {
    return;
  }

  expoOutput.value = buildExpoTemplate(report);

  try {
    await navigator.clipboard.writeText(expoOutput.value);
    setFeedback(expoFeedback, "Discord-Vorlage wurde erstellt und kopiert.");
  } catch {
    expoOutput.focus();
    expoOutput.select();
    const copied = document.execCommand("copy");
    setFeedback(expoFeedback, copied ? "Discord-Vorlage wurde erstellt und kopiert." : "Vorlage wurde erstellt, konnte aber nicht kopiert werden.", !copied);
  }
}

async function fetchParticipantPage(offset) {
  const url = new URL(EVENT_PARTICIPANTS_API_URL);
  url.searchParams.set("limit", String(API_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Teilnehmerdaten nicht erreichbar (${response.status}).`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.rows)) {
    throw new Error("Die API hat keine lesbaren Teilnehmerdaten geliefert.");
  }

  return payload;
}

async function loadParticipantEarnings() {
  if (isLoading) {
    return;
  }

  setLoading(true);
  setSourceStatus("DATEN WERDEN GELADEN");
  setDataSourceState("LADE", "EVENT-PARTICIPANTS / NUR LESEN");
  tableFeedback.textContent = "Teilnehmerdaten werden abgerufen ...";

  try {
    const rows = [];
    let offset = 0;
    let total = 0;

    do {
      const page = await fetchParticipantPage(offset);
      const pageRows = page.rows;
      total = Number.isFinite(Number(page.total)) ? Number(page.total) : offset + pageRows.length;
      rows.push(...pageRows);
      offset += pageRows.length;

      if (pageRows.length === 0) {
        break;
      }
    } while (offset < total);

    allParticipantRows = rows;
    dailyReports = buildDailyReports(allParticipantRows);

    const reportStartDate = getBerlinDateKey();
    const currentRows = rows.filter((row) => isOnOrAfterReportStart(row, reportStartDate));
    const calculation = buildEarnings(currentRows);
    earnings = calculation.people;
    eventCount = calculation.eventCount;
    attendanceCount = calculation.attendanceCount;
    totalPayout = calculation.totalPayout;

    emptyStateCopy.textContent = `Keine Eventteilnahmen ab ${formatDateKey(reportStartDate)} gefunden.`;
    tableFeedback.textContent = `${formatNumber(attendanceCount)} eindeutige Teilnahmen ab ${formatDateKey(reportStartDate)} aus ${formatNumber(currentRows.length)} API-Datensaetzen berechnet.`;
    setSourceStatus("API VERBUNDEN");
    setDataSourceState("BEREIT", `EVENTS AB ${formatDateKey(reportStartDate)} / ${formatNumber(currentRows.length)} DATENSAETZE`);
    renderParticipants();

    if (isGotaAuthorized) {
      populateDailyDateSelect();
      renderDailyView();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Die Teilnehmerdaten konnten nicht geladen werden.";
    earnings = [];
    eventCount = 0;
    attendanceCount = 0;
    totalPayout = 0;
    allParticipantRows = [];
    dailyReports = [];
    emptyStateCopy.textContent = message;
    tableFeedback.textContent = "Die Verdienste konnten nicht aktualisiert werden.";
    setSourceStatus("API NICHT ERREICHBAR", true);
    setDataSourceState("NICHT ERREICHBAR", "API / KEINE LOKALEN DATEN", true);
    renderParticipants();

    if (isGotaAuthorized) {
      populateDailyDateSelect();
      renderDailyView();
    }
  } finally {
    setLoading(false);
  }
}

participantSearch.addEventListener("input", renderParticipants);
refreshButton.addEventListener("click", loadParticipantEarnings);
gotaTrigger.addEventListener("click", () => {
  if (isGotaAuthorized) {
    setGotaAuthorization(false);
    return;
  }

  setFeedback(authFeedback, "");
  authDialog.showModal();
  gotaPassword.focus();
});
document.querySelector("#dialog-close").addEventListener("click", () => authDialog.close());
authForm.addEventListener("submit", authorizeGota);
dailyDate.addEventListener("change", () => {
  renderDailyView();
  expoFeedback.textContent = "";
});
expoButton.addEventListener("click", createAndCopyExpo);

document.querySelector("#current-date").textContent = new Intl.DateTimeFormat("de-DE", {
  timeZone: BERLIN_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
}).format(new Date()).toUpperCase();

lucide.createIcons();
setGotaAuthorization(false);
renderParticipants();
loadParticipantEarnings();
