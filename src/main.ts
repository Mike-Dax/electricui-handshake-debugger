import * as testCases from './tests/'

import { Configuration, StreamReport } from '@electricui/script-utilities'
import { LogMessageName } from './LogMessageName'

const configuration = new Configuration({
  logFilters: [],
  enableColors: true,
  enableHyperlinks: false,
  enableProgressBars: true,
  preferTruncatedLines: true,
  enableTimers: true,
  displayTimerThreshold: 2,
})

async function main() {
  const forgettableNames = new Set([
    LogMessageName.TRANSIENT,
  ])

  const installReport = await StreamReport.start(
    {
      configuration,
      json: false,
      stdout: process.stdout,
      includeLogs: true,
      forgettableNames,
    },
    async report => {
      for (const closure of Object.values(testCases)) {
        await closure(report)
      }
    },
  )

  process.exit(installReport.exitCode())
}

main()
