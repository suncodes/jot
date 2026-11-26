import { BookOpen, BriefcaseBusiness, CalendarDays, Command, FilePlus2, Lightbulb, NotebookPen, SunMoon } from 'lucide-vue-next'
import type { AppExtensionIcon } from '@shared/app-extensions'

export const commandIcons = {
  'book-open': BookOpen, 'briefcase-business': BriefcaseBusiness, 'calendar-days': CalendarDays,
  'file-plus': FilePlus2, lightbulb: Lightbulb, 'notebook-pen': NotebookPen, 'sun-moon': SunMoon, command: Command,
} satisfies Record<AppExtensionIcon, unknown>
