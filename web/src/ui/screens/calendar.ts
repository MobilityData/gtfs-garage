/**
 * Which day to look at, and when the schedule stops being this schedule.
 *
 * This was a year grid, and a year grid cannot be the answer: a feed declaring
 * service to 2100 is twenty-eight thousand cells, and nobody reads one to find
 * a Tuesday. What a person wants from a calendar is two things - a day to look
 * at, and the dates on which the timetable was replaced - so the screen is
 * those two things and little else.
 *
 * **Service periods** puts one band per kind of day across the feed's whole
 * range, however long that is: the week "Weekdays" ends and "Mon, Tue, Wed,
 * Fri" begins is visible as the place one band stops and another starts.
 * **When the schedule changes** lists those boundaries as dates you can go to.
 *
 * Nothing here filters anything by itself. Choosing a day sets the date the
 * rest of the viewer reads, and the screen says which state it is in.
 */

import type { CalendarSummary, ServicePattern, ViewerSource } from "../../sources/types";
import { gaps } from "../calendar-grid";
import { longDate } from "../date-bar";
import { action, append, node, section } from "../html";
import { changes, describeChange, periods } from "../service-periods";
import type { Screen, ScreenContext } from "./types";

export function renderCalendar(data: CalendarSummary, context: ScreenContext): HTMLElement {
  const root = node("div", { class: "explore calendar" });
  const choose = (date: string) => context.setDate(date);

  append(
    root,
    header(data, context),
    timeline(data, choose),
    whenItChanges(data, choose),
    kinds(data.patterns, context, choose),
    quietRuns(data),
  );
  return root;
}

function header(data: CalendarSummary, context: ScreenContext): HTMLElement {
  const running = data.days.filter((day) => day.trips).length;

  return node("div", { class: "overview-header" }, [
    node("div", {}, [
      node("h2", { text: "Service days" }),
      node("div", {
        class: "explore-hint",
        text:
          data.first_date && data.last_date
            ? `${data.first_date} to ${data.last_date} — ${running.toLocaleString()} of ${data.days.length.toLocaleString()} days have service`
            : "This feed states no service dates",
      }),
      node("div", {
        class: "explore-hint",
        text: context.date
          ? `Looking at ${longDate(context.date)}. Pick another below, or clear it to see the whole feed again.`
          : "Nothing is filtered by date. Pick a day and the routes, timetables and map will show it.",
      }),
    ]),
    data.truncated
      ? node(
          "div",
          {
            class: "window-badge window-warn",
            title: "Expansion stops after about three years; an end date further out is almost always a typo.",
          },
          [node("div", { class: "window-remaining", text: "Window cut short" })],
        )
      : null,
  ]);
}

/**
 * One band per kind of day, across the feed's whole range.
 *
 * The bands are positioned rather than listed: where one stops and another
 * starts *is* the information, and a table of date ranges makes the reader do
 * that comparison in their head.
 */
function timeline(data: CalendarSummary, choose: (date: string) => void): HTMLElement | null {
  if (!data.first_date || !data.last_date) return null;
  const bands = periods(data.patterns, data.first_date, data.last_date);
  if (!bands.length) return null;

  const chart = node("div", { class: "periods" });

  for (const period of bands) {
    const bar = node("button", {
      class: "period-bar",
      style: `left:${(period.start * 100).toFixed(3)}%;width:${(period.width * 100).toFixed(3)}%`,
      title: `${period.from} to ${period.to} — ${period.days} days, ${period.routes} routes, ${period.trips} trips. Click to look at ${period.from}.`,
    });
    bar.addEventListener("click", () => choose(period.from));

    chart.append(
      node("div", { class: "period-row" }, [
        node("span", { class: "period-name", text: period.name }),
        node("span", { class: "period-track" }, [bar]),
        node("span", { class: "period-days", text: `${period.days.toLocaleString()} d` }),
      ]),
    );
  }

  chart.append(
    node("div", { class: "period-row period-axis" }, [
      node("span", { class: "period-name" }),
      node("span", { class: "period-track" }, [
        node("span", { class: "axis-start", text: data.first_date }),
        node("span", { class: "axis-end", text: data.last_date }),
      ]),
      node("span", { class: "period-days" }),
    ]),
  );

  return section(
    "Service periods",
    "Each kind of day, and the stretch of the feed it is in force for. Click a band to look at a day of that kind.",
    [chart],
  );
}

/** The dates the timetable was replaced - what the bands' edges mean. */
function whenItChanges(data: CalendarSummary, choose: (date: string) => void): HTMLElement | null {
  if (!data.first_date || !data.last_date) return null;
  const found = changes(data.patterns, data.first_date, data.last_date);
  if (!found.length) return null;

  const list = node("ul", { class: "change-list" });
  for (const change of found.slice(0, 20)) {
    list.append(
      node("li", {}, [
        node("span", { class: "change-date", text: change.date }),
        node("span", { class: "explore-hint", text: describeChange(change) }),
        action("Look at this day", `Make ${change.date} the day every view shows`, () => choose(change.date)),
      ]),
    );
  }
  if (found.length > 20) {
    list.append(node("li", { class: "explore-hint", text: `and ${found.length - 20} more` }));
  }

  return section(
    "When the schedule changes",
    "The dates a kind of day starts or stops being in force - not every Saturday, but the moments the timetable was actually replaced.",
    [list],
  );
}

/** What each kind of day holds, and the services behind it. */
function kinds(list: ServicePattern[], context: ScreenContext, choose: (date: string) => void): HTMLElement {
  const body = node("tbody");

  for (const pattern of list) {
    const services = node("td", { class: "service-ids" });
    if (pattern.services.length) {
      for (const service of pattern.services.slice(0, 6)) {
        services.append(
          action(service, `Open calendar.txt for ${service}`, () =>
            context.openTable("calendar", [{ column: "service_id", op: "eq", value: service }]),
          ),
        );
      }
      if (pattern.services.length > 6) {
        services.append(node("span", { class: "explore-hint", text: `+${pattern.services.length - 6}` }));
      }
    } else {
      services.append(node("span", { class: "explore-hint", text: "none" }));
    }

    body.append(
      node("tr", { class: pattern.trips ? "" : "pattern-empty" }, [
        node("td", {}, [
          node("div", { class: "pattern-name", text: pattern.name }),
          pattern.trips
            ? action(`Look at ${pattern.first_date}`, "Make this the day every view shows", () =>
                choose(pattern.first_date),
              )
            : node("div", { class: "explore-hint", text: pattern.sample_dates.slice(0, 2).join(", ") }),
        ]),
        node("td", { class: "numeric", text: pattern.days.toLocaleString() }),
        node("td", { class: "numeric", text: pattern.routes.toLocaleString() }),
        node("td", { class: "numeric", text: pattern.trips.toLocaleString() }),
        services,
      ]),
    );
  }

  const table = node("table", { class: "explore-table" }, [
    node("thead", {}, [
      node("tr", {}, [
        node("th", { text: "Kind of day" }),
        node("th", { class: "numeric", text: "Days" }),
        node("th", { class: "numeric", text: "Routes" }),
        node("th", { class: "numeric", text: "Trips" }),
        node("th", { text: "Services" }),
      ]),
    ]),
    body,
  ]);

  return section(
    "Kinds of day",
    "Dates on which exactly the same set of services runs, grouped together. Routes and trips are what one such day holds.",
    [node("div", { class: "explore-scroll" }, [table])],
  );
}

function quietRuns(data: CalendarSummary): HTMLElement | null {
  const found = gaps(data.days, 2).slice(0, 6);
  if (!found.length) return null;

  const list = node("ul", { class: "gap-list" });
  for (const gap of found) {
    list.append(
      node("li", {}, [
        node("strong", { text: `${gap.days} days` }),
        node("span", { text: gap.from === gap.to ? ` on ${gap.from}` : ` from ${gap.from} to ${gap.to}` }),
      ]),
    );
  }

  return section(
    "Gaps in service",
    "Runs of two or more days with nothing running. A weekend is a schedule; a week in July is a shutdown or a mistake.",
    [list],
  );
}

/** Which day to look at, and when the schedule changes. */
export const calendarScreen: Screen<CalendarSummary> = {
  id: "calendar",
  label: "Service days",
  title: "Pick the day every view shows, and see when the schedule changes",
  // No map: this is a picker and two tables, and the map beside it showed the
  // whole network while taking half the width from them.
  layout: "none",
  available: (source: ViewerSource) => typeof source.calendar === "function",
  fetch: (source: ViewerSource) => source.calendar!(),
  render: renderCalendar,
};
