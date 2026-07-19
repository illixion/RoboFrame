	.set noreorder

#include "pspstub.s"

	STUB_START "kdisp",0x40090000,0x00020005
	STUB_FUNC  0xE5334432,kdispSetDisplay
	STUB_FUNC  0xC3CE89E4,kdispHasLcdPower
	STUB_END
