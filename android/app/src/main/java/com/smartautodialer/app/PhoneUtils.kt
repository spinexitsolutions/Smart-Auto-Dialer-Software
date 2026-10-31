package com.smartautodialer.app

/** Small helpers for phone-number handling. */
object PhoneUtils {

    /** ASCII digits only. */
    fun digits(value: String?): String = value?.filter { it in '0'..'9' }.orEmpty()

    /** Last 10 digits, used to compare numbers regardless of country code / formatting. */
    fun last10(value: String?): String = digits(value).takeLast(10)

    fun sameNumber(a: String?, b: String?): Boolean {
        val x = last10(a)
        return x.isNotEmpty() && x == last10(b)
    }

    /** Keeps a leading '+', digits, '*' and '#'; strips spaces, dashes, brackets, etc. */
    fun sanitizeForDial(raw: String?): String {
        val sb = StringBuilder()
        raw?.trim()?.forEach { c ->
            when {
                c in '0'..'9' || c == '*' || c == '#' -> sb.append(c)
                c == '+' && sb.isEmpty() -> sb.append(c)
            }
        }
        return sb.toString()
    }
}
