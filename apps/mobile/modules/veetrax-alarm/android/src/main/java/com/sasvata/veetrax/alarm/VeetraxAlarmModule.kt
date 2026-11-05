package com.sasvata.veetrax.alarm

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VeetraxAlarmModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("VeetraxAlarm")

    Function("start") { title: String, text: String, alertId: String ->
      AlarmService.start(context, title, text, alertId)
    }

    Function("stop") {
      AlarmService.stop(context)
    }
  }
}
