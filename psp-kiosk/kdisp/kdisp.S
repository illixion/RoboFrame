	.set noreorder

#include "pspstub.s"

	STUB_START "kdisp",0x40090000,0x00010005
	STUB_FUNC  0xE5334432,kdispSetDisplay
	STUB_END
