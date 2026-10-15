/**
 * The screens the viewer ships with.
 *
 * An ordinary array, in sidebar order, with no privileges a host's own screen
 * lacks. Pass `screens` to `mount` to add to it, replace a member, reorder it
 * or drop it:
 *
 *     import { mount, defaultScreens } from "gtfs-garage-web";
 *
 *     mount(root, { screens: [...defaultScreens, myFaresScreen] });
 *     mount(root, { screens: defaultScreens.filter((s) => s.id !== "calendar") });
 *     mount(root, { screens: [] });   // the file browser alone
 *
 * `route` and `timetable` come last and have no label: they are detail screens,
 * reached from the list and from a route rather than from the sidebar.
 */

export type { Screen, ScreenContext } from "./types";
export { availableScreens, listedScreens } from "./types";

export { overviewScreen, renderOverview } from "./overview";
export { calendarScreen, renderCalendar } from "./calendar";
export { routeListScreen, routeScreen, renderRoute, renderRouteList } from "./routes";
export type { RouteListing } from "./routes";
export { timetableScreen, renderTimetable, renderTimetableView } from "./timetable";
export type { TimetableView } from "./timetable";

import { calendarScreen } from "./calendar";
import { overviewScreen } from "./overview";
import { routeListScreen, routeScreen } from "./routes";
import { timetableScreen } from "./timetable";
import type { Screen } from "./types";

export const defaultScreens: Screen[] = [
  overviewScreen as Screen,
  calendarScreen as Screen,
  routeListScreen as Screen,
  routeScreen as Screen,
  timetableScreen as Screen,
];
