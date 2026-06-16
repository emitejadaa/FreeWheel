import { PartialType } from "@nestjs/mapped-types";
import { CreateListingDto } from "./create-listing.dto";

// Every field of CreateListingDto, made optional (validation rules preserved).
export class UpdateListingDto extends PartialType(CreateListingDto) {}
