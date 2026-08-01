import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from "@sequelize/core";
import {
  Attribute,
  AutoIncrement,
  CreatedAt,
  DeletedAt,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
  Version,
} from "@sequelize/core/decorators-legacy";
import { FeedbackApi } from "../../api/feedback";

@Table({ modelName: "Feedback" })
export class FeedbackDao extends Model<
  InferAttributes<FeedbackDao>,
  InferCreationAttributes<FeedbackDao>
> {
  @AutoIncrement
  @PrimaryKey
  @Attribute(DataTypes.INTEGER)
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare userId: number;

  @Attribute(DataTypes.TEXT)
  declare errorMessage: string | null;

  @Attribute(DataTypes.TEXT)
  declare errorStack: string | null;

  @Attribute(DataTypes.TEXT)
  declare userMessage: string | null;

  @Attribute(DataTypes.TEXT)
  @NotNull
  declare url: string;

  @Version
  @NotNull
  declare internalVersion: CreationOptional<number>;

  @Attribute(DataTypes.DATE(3))
  @CreatedAt
  @NotNull
  declare createdAt: CreationOptional<Date>;

  @Attribute(DataTypes.DATE(3))
  @UpdatedAt
  @NotNull
  declare updatedAt: CreationOptional<Date>;

  @Attribute(DataTypes.DATE(3))
  @DeletedAt
  declare deletedAt: Date | null;

  toApi(): FeedbackApi {
    return {
      id: this.id,
      userId: this.userId,
      errorMessage: this.errorMessage ?? undefined,
      errorStack: this.errorStack ?? undefined,
      userMessage: this.userMessage ?? undefined,
      createdAt: this.createdAt.toString(),
      url: this.url,
    };
  }
}
